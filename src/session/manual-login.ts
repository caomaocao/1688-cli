import type { BrowserContext } from 'playwright';
import { parseIdentity } from '../auth/cookies.js';
import { CliError } from '../io/errors.js';
import { info } from '../io/output.js';
import { nowIso } from '../util/time.js';
import { isLoginUrl } from './page-state.js';
import { readState, writeState } from './state.js';
import { sleep } from './wait.js';

/** The slice of a Playwright page this wait touches — small enough to fake in tests. */
export interface LoginWaitPage {
  url(): string;
  isClosed(): boolean;
  goto(url: string, opts?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
}

export interface ManualLoginOpts {
  /** Where the command was going; revisited once the user has logged in. */
  returnUrl: string;
  /** Whether the session is live again (the offer page renders for anonymous visitors too). */
  isLoggedIn: () => Promise<boolean>;
  timeoutMs?: number;
  pollMs?: number;
  /** Runs after the login sticks (default: refresh `state.json` from the context's cookies). */
  onLoggedIn?: () => Promise<void>;
}

export const MANUAL_LOGIN_TIMEOUT_MS = 300_000;
export const LOGIN_URL = 'https://login.1688.com/member/signin.htm?tbpm=1';

/**
 * A `--headed` command that lands on 1688's login page used to throw NOT_LOGGED_IN on the spot:
 * the window flashed and closed before anyone could scan. Instead, open the login page (1688
 * often renders the offer anonymously instead of redirecting), keep the window open until the
 * user has logged in there, then go back to `returnUrl`. The login counts once `returnUrl` loads
 * without bouncing to the login page and the cookies say the session is live. Headless callers
 * never get here.
 */
export async function waitForManualLogin(
  page: LoginWaitPage,
  opts: ManualLoginOpts,
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? MANUAL_LOGIN_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? 1000;
  info(
    `1688 has logged this account out. Scan the QR code in the browser window to log back in (waiting up to ${Math.round(timeoutMs / 1000)}s)...`,
  );
  if (!isLoginUrl(page.url())) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new CliError(130, 'CANCELED', 'Browser closed before login.');
    if (!isLoginUrl(page.url()) && (await opts.isLoggedIn().catch(() => false))) {
      if (page.url() !== opts.returnUrl) {
        await page
          .goto(opts.returnUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
          .catch(() => {});
      }
      if (!page.isClosed() && !isLoginUrl(page.url())) {
        await opts.onLoggedIn?.().catch(() => {});
        info('Logged in. Continuing...');
        return;
      }
    }
    await sleep(pollMs);
  }
  throw new CliError(
    3,
    'NOT_LOGGED_IN',
    `Login not completed within ${Math.round(timeoutMs / 1000)}s. Run \`1688 login --force --headed\`.`,
    { category: 'not_logged_in', currentUrl: page.isClosed() ? undefined : page.url() },
  );
}

/** Keep `state.json` in step with a login done inside a command window, so a later
 *  `1688 login` / `whoami` does not report the account that was logged out. */
export function refreshStateFromContext(
  ctx: BrowserContext,
  profile?: string,
): () => Promise<void> {
  return async () => {
    const id = parseIdentity(await ctx.cookies());
    if (!id) return;
    const prev = await readState(profile).catch(() => null);
    await writeState({
      ...(prev ?? { version: 1 }),
      version: 1,
      memberId: id.memberId,
      nick: id.nick ?? undefined,
      loggedInAt: nowIso(),
      lastVerifiedAt: nowIso(),
    }, profile);
  };
}
