import type { BrowserContext, Page } from 'playwright';
import QRCode from 'qrcode';
import { withSession } from '../session/context.js';
import { parseIdentity, type Identity } from '../auth/cookies.js';
import { writeState, readState } from '../session/state.js';
import { emit, info, isJson } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { nowIso } from '../util/time.js';
import { defaultProfileName, loginQrFile, ensureRoot } from '../session/paths.js';
import { sleep } from '../session/wait.js';
import { LOGIN_URL } from '../session/manual-login.js';

export interface LoginOpts {
  force?: boolean;
  timeout?: string;
  profile?: string;
  headed?: boolean;
  noDaemon?: boolean;
}

async function ensureDaemonStarted(opts: LoginOpts): Promise<void> {
  if (opts.noDaemon) return;
  const profile = defaultProfileName(opts.profile);
  try {
    const { status, start } = await import('../daemon/manager.js');
    const st = await status(profile);
    if (st.running) {
      info(`Daemon already running for profile "${profile}" (pid ${st.pid}).`);
      return;
    }
    info(`Starting daemon for profile "${profile}" to keep browser warm (reduces risk control hits)...`);
    const { pid } = await start(profile);
    info(`Daemon ready for profile "${profile}" (pid ${pid}) — next commands will reuse this context.`);
  } catch (e) {
    info(`(Daemon auto-start skipped for profile "${profile}": ${(e as Error).message})`);
  }
}

const WARMUP_URL =
  'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html';

export async function run(opts: LoginOpts): Promise<void> {
  const profile = defaultProfileName(opts.profile);
  const timeoutMs = Math.max(30, parseInt(opts.timeout ?? '300', 10)) * 1000;
  const headed = opts.headed === true;

  if (!opts.force) {
    // Try the cached identity first — no browser needed, so this works even
    // while the daemon holds the lock. Falls back to a browser cookie peek
    // only if state.json doesn't have a usable identity.
    const cached = await peekFromState(profile);
    const existing = cached ?? (await peekIdentity(profile));
    if (existing) {
      const name = existing.nick ?? existing.memberId;
      emit({
        human: () =>
          info(
            `Already logged in as ${name} (memberId: ${existing.memberId}). Use --force to re-login.`,
          ),
        data: {
          ok: true,
          alreadyLoggedIn: true,
          memberId: existing.memberId,
          nick: existing.nick,
        },
      });
      await ensureDaemonStarted(opts);
      return;
    }
  }

  const identity = await withSession(
    { headless: !headed, profile: opts.profile },
    async (ctx) => {
      if (opts.force) await clearAlibabaCookies(ctx);
      const page = await ctx.newPage();
      if (headed) {
        info('Opening 1688 login page in a browser window...');
        info('Scan the QR code with your 1688 or Taobao app.');
      } else {
        printInteractive('Generating QR code...');
        attachQrRenderer(page);
      }
      await page.goto(LOGIN_URL);
      await waitForLogin(ctx, page, timeoutMs, headed);
      printInteractive('Confirmed. Finalizing session...');
      try {
        await page.goto(WARMUP_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
      } catch {
        /* ignore warmup failure */
      }
      const id = parseIdentity(await ctx.cookies());
      if (!id) {
        throw new CliError(
          8,
          'LOGIN_INCOMPLETE',
          'Login flow finished but identity cookies are missing. Try --headed.',
        );
      }
      return id;
    },
  );

  await writeState({
    version: 1,
    memberId: identity.memberId,
    nick: identity.nick ?? undefined,
    loggedInAt: nowIso(),
    lastVerifiedAt: nowIso(),
  }, profile);

  const name = identity.nick ?? identity.memberId;
  emit({
    human: () =>
      process.stdout.write(
        `Logged in as ${name} (memberId: ${identity.memberId})\n`,
      ),
    data: { ok: true, memberId: identity.memberId, nick: identity.nick },
  });
  await ensureDaemonStarted(opts);
}

async function peekIdentity(profile?: string): Promise<Identity | null> {
  return withSession({ headless: true, profile }, async (ctx) =>
    parseIdentity(await ctx.cookies()),
  );
}

/**
 * Quick already-logged-in check that doesn't touch the browser, so it works
 * while the daemon holds the lock. Reads only the cached state.json.
 */
async function peekFromState(profile?: string): Promise<Identity | null> {
  try {
    const s = await readState(profile);
    if (!s.memberId || !s.nick) return null;
    return { memberId: s.memberId, nick: s.nick };
  } catch {
    return null;
  }
}

async function clearAlibabaCookies(ctx: BrowserContext): Promise<void> {
  const all = await ctx.cookies();
  try {
    await ctx.clearCookies({ domain: /\.1688\.com$/ });
    await ctx.clearCookies({ domain: /\.taobao\.com$/ });
    return;
  } catch {
    const keep = all.filter(
      (c) =>
        !c.domain.endsWith('.1688.com') && !c.domain.endsWith('.taobao.com'),
    );
    await ctx.clearCookies();
    if (keep.length) await ctx.addCookies(keep);
  }
}

async function waitForLogin(
  ctx: BrowserContext,
  page: Page,
  timeoutMs: number,
  headed: boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) {
      throw new CliError(
        130,
        'CANCELED',
        headed
          ? 'Login canceled (browser closed).'
          : 'Login canceled.',
      );
    }
    let cookies;
    try {
      cookies = await ctx.cookies();
    } catch {
      throw new CliError(130, 'CANCELED', 'Login canceled.');
    }
    if (
      cookies.some(
        (c) => c.name === 'unb' && c.domain.endsWith('.1688.com'),
      )
    ) {
      return;
    }
    await sleep(1000);
  }
  throw new CliError(
    7,
    'LOGIN_TIMEOUT',
    `Login timed out after ${Math.round(timeoutMs / 1000)}s. ` +
      `If the QR never appeared, try \`1688 login --headed\`.`,
  );
}

// ── QR rendering ──────────────────────────────────────────────────────────

function attachQrRenderer(page: Page): void {
  let lastContent: string | undefined;
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/qrcode\/generate/i.test(url)) return;
    let json: unknown;
    try {
      json = await resp.json();
    } catch {
      try {
        const txt = await resp.text();
        json = JSON.parse(txt);
      } catch {
        return;
      }
    }
    const content = findValue(json, 'codeContent');
    if (!content || content === lastContent) return;
    const refreshing = lastContent !== undefined;
    lastContent = content;
    await renderQrToTerminal(content, refreshing);
  });
}

async function renderQrToTerminal(
  content: string,
  refreshing: boolean,
): Promise<void> {
  const out = process.stderr;
  out.write('\n');
  if (refreshing) {
    out.write('QR refreshed — scan the new code:\n\n');
  } else {
    out.write('Scan with your 1688 or Taobao app:\n\n');
  }
  // ASCII render only works in a real terminal. Agents (Codex / Claude
  // Code) usually run the CLI without a TTY for stderr, so the ASCII art
  // would not display correctly. Always also save a PNG copy that the
  // agent can surface to the user as an image attachment.
  if (out.isTTY) {
    try {
      const ascii = await QRCode.toString(content, {
        type: 'terminal',
        small: true,
      });
      out.write(ascii);
    } catch (e) {
      out.write(`(QR render failed: ${(e as Error).message})\n`);
    }
  }
  try {
    await ensureRoot();
    const pngPath = loginQrFile();
    await QRCode.toFile(pngPath, content, { width: 400, margin: 2 });
    if (!out.isTTY) {
      out.write(
        `(non-TTY — agent: show the PNG below to the user; user: open it on a screen the phone can see, then scan with the 1688 app)\n`,
      );
    }
    out.write(`QR saved as PNG: ${pngPath}\n`);
  } catch (e) {
    out.write(`(QR PNG save failed: ${(e as Error).message})\n`);
  }
  out.write(`Raw QR content: ${content}\n`);
  out.write('\nWaiting for scan + confirmation...\n');
}

function printInteractive(msg: string): void {
  // Always write to stderr — keeps stdout JSON clean for pipes/agents.
  if (!isJson()) {
    process.stderr.write(`→ ${msg}\n`);
  }
}

function findValue(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  if (typeof o[key] === 'string') return o[key];
  for (const v of Object.values(o)) {
    const r = findValue(v, key);
    if (r) return r;
  }
  return undefined;
}
