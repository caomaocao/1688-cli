// `image-search --engine plugin`: drive 1688's image search through the two
// mtop calls the official "1688官方采购助手" extension uses for 找同款, instead of
// scraping the upload + results pages.
//
// Layout:
//   runPluginSearch(transport, args)  — the whole flow (upload → pages → map →
//                                        truncate), browser-free; unit-tested
//                                        with a fake transport.
//   pageTransport(page)                — MtopTransport backed by
//                                        window.lib.mtop.request on a 1688 page.
//   getHostPage(ctx)                   — lazily created, cached, health-checked
//                                        hidden page that hosts lib.mtop.
//   execute(ctx, args)                 — daemon/inline entry point.

import fs from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import { CliError } from '../io/errors.js';
import { info } from '../io/output.js';
import { withRecovery } from '../session/recovery.js';
import { sleep } from '../session/wait.js';
import {
  PLUGIN_HOST_PAGE_URL,
  PLUGIN_MAX_BASE64_BYTES,
  PLUGIN_PAGE_SIZE,
  buildSearchRequest,
  buildUploadRequest,
  classifyMtopRet,
  mapPluginPage,
  mtopRetCode,
  pagesFor,
  parseSearchResponse,
  parseUploadResponse,
  type MtopEnvelope,
  type MtopRequestSpec,
  type PluginOffer,
} from '../session/plugin-image-search.js';

export type MtopTransport = (spec: MtopRequestSpec) => Promise<MtopEnvelope>;

export interface PluginSearchArgs {
  imagePath?: string | null;
  imageId?: string | null;
  region?: string | null;
  max: number;
  raw?: boolean;
}

export interface PluginSearchResult {
  engine: 'plugin';
  imageId: string;
  total: number;
  offers: PluginOffer[];
  region: string | null;
  yoloCropRegion: string[];
  pagesFetched: number;
}

export interface PluginSearchHooks {
  // Wait between consecutive page requests. Injectable so tests run instantly.
  pageGap?: () => Promise<void>;
}

const PAGE_GAP_MS: [number, number] = [2000, 4000];

function jitter([lo, hi]: [number, number]): number {
  return lo + Math.floor(Math.random() * (hi - lo));
}

async function defaultPageGap(): Promise<void> {
  await sleep(jitter(PAGE_GAP_MS));
}

// Maps a non-success mtop `ret` onto the CLI's error vocabulary. The codes
// RISK_CONTROL / NOT_LOGGED_IN are the ones the shared recovery layer already
// understands, so daemon health accounting and the `--headed` hint apply.
export function mtopFailure(ret: string, stage: 'upload' | 'search'): CliError {
  const kind = classifyMtopRet(ret);
  const shown = ret || 'empty mtop response';
  switch (kind) {
    case 'risk_control':
      return new CliError(
        4,
        'RISK_CONTROL',
        `1688 risk control blocked the image search (${stage}): ${shown}. Run once with \`--headed\` to solve the verification manually.`,
        {
          ret,
          stage,
          category: 'risk_challenge',
          recoverHint:
            '1688 returned a verification challenge for the plugin engine. Retry once with `--headed`, solve the slider, then continue.',
          retryable: false,
        },
      );
    case 'not_logged_in':
      return new CliError(
        3,
        'NOT_LOGGED_IN',
        `1688 session expired during image search (${stage}): ${shown}. Run \`1688 login\`.`,
        { ret, stage, category: 'not_logged_in', retryable: false },
      );
    default:
      return new CliError(
        9,
        'UPSTREAM_ERROR',
        `1688 image search (${stage}) failed: ${shown}`,
        { ret, stage, category: 'upstream' },
      );
  }
}

// --- pacing ----------------------------------------------------------------
// The plugin engine is paced more conservatively than the daemon's generic
// per-command throttle: at least 3 s plus 0–3 s jitter since the previous
// plugin call finished, regardless of what else the daemon ran in between.

export const PLUGIN_PACE_MIN_MS = 3000;
export const PLUGIN_PACE_JITTER_MS = 3000;

let lastPluginCallEndedAt = 0;

export function nextPluginCallDelay(
  now: number,
  lastEndedAt: number = lastPluginCallEndedAt,
  random: () => number = Math.random,
): number {
  if (!lastEndedAt) return 0;
  const target = lastEndedAt + PLUGIN_PACE_MIN_MS + Math.floor(random() * PLUGIN_PACE_JITTER_MS);
  return Math.max(0, target - now);
}

export async function pacePluginCall(sleepFn: (ms: number) => Promise<void> = sleep): Promise<void> {
  const wait = nextPluginCallDelay(Date.now());
  if (wait > 0) {
    info(`Pacing plugin engine: waiting ${(wait / 1000).toFixed(1)}s...`);
    await sleepFn(wait);
  }
}

export function markPluginCallEnded(at: number = Date.now()): void {
  lastPluginCallEndedAt = at;
}

async function readImageBase64(imagePath: string): Promise<string> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(imagePath);
  } catch {
    throw new CliError(2, 'BAD_INPUT', `Cannot read image: ${imagePath}`);
  }
  if (buf.length === 0) {
    throw new CliError(2, 'BAD_INPUT', `Image is empty: ${imagePath}`);
  }
  const b64 = buf.toString('base64');
  if (b64.length > PLUGIN_MAX_BASE64_BYTES) {
    throw new CliError(
      2,
      'BAD_INPUT',
      `Image too large for the plugin engine (${(b64.length / 1024 / 1024).toFixed(1)}MB base64 > 4MB). Shrink it first; the engine does not resize so --region stays 1:1 with your file.`,
    );
  }
  return b64;
}

export async function runPluginSearch(
  transport: MtopTransport,
  args: PluginSearchArgs,
  hooks: PluginSearchHooks = {},
): Promise<PluginSearchResult> {
  let imageId = args.imageId ?? null;
  if (!imageId) {
    if (!args.imagePath) {
      throw new CliError(2, 'BAD_INPUT', 'Image path or --image-id required.');
    }
    const b64 = await readImageBase64(args.imagePath);
    info('Uploading image to 1688 (plugin engine)...');
    const env = await transport(buildUploadRequest(b64));
    const ret = mtopRetCode(env);
    if (classifyMtopRet(ret) !== 'ok') throw mtopFailure(ret, 'upload');
    imageId = parseUploadResponse(env.data);
    if (!imageId) {
      throw new CliError(13, 'UPLOAD_FAILED', 'No imageId in upload response.', {
        stage: 'upload',
      });
    }
    info(`Image uploaded (imageId=${imageId}). Fetching results...`);
  }

  const pages = pagesFor(args.max);
  const offers: PluginOffer[] = [];
  let total = 0;
  let region: string | null = null;
  let yoloCropRegion: string[] = [];
  let pagesFetched = 0;

  for (let page = 1; page <= pages; page++) {
    if (page > 1) await (hooks.pageGap ?? defaultPageGap)();
    const env = await transport(
      buildSearchRequest({ imageId, beginPage: page, region: args.region ?? null }),
    );
    pagesFetched = page;
    const ret = mtopRetCode(env);
    if (classifyMtopRet(ret) !== 'ok') throw mtopFailure(ret, 'search');
    const parsed = parseSearchResponse(env.data);
    if (page === 1) {
      total = parsed.total;
      region = parsed.region;
      yoloCropRegion = parsed.yoloCropRegion;
    }
    offers.push(...mapPluginPage(parsed, { raw: args.raw === true }));
    if (parsed.offers.length < PLUGIN_PAGE_SIZE) break; // pool exhausted
  }

  return {
    engine: 'plugin',
    imageId,
    total,
    offers: offers.slice(0, args.max),
    region,
    yoloCropRegion,
    pagesFetched,
  };
}

// ---------------------------------------------------------------------------
// Browser side
// ---------------------------------------------------------------------------

const LOGIN_OR_PUNISH_RE = /login\.(?:1688|taobao)\.com|passport\.1688\.com|\/punish\b|x5secdata/i;
const HOST_PAGE_READY_TIMEOUT_MS = 20000;

const hostPages = new WeakMap<BrowserContext, Page>();

async function hasMtop(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const w = window as unknown as { lib?: { mtop?: { request?: unknown } } };
      return typeof w.lib?.mtop?.request === 'function';
    });
  } catch {
    return false;
  }
}

async function isHealthy(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  if (LOGIN_OR_PUNISH_RE.test(page.url())) return false;
  return hasMtop(page);
}

async function openHostPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  try {
    await page.goto(PLUGIN_HOST_PAGE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    if (/login\.(?:1688|taobao)\.com|passport\.1688\.com/i.test(page.url())) {
      throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
    }
    await page.waitForFunction(
      () => {
        const w = window as unknown as { lib?: { mtop?: { request?: unknown } } };
        return typeof w.lib?.mtop?.request === 'function';
      },
      undefined,
      { timeout: HOST_PAGE_READY_TIMEOUT_MS },
    );
    return page;
  } catch (e) {
    await page.close().catch(() => {});
    if (e instanceof CliError) throw e;
    throw new CliError(
      9,
      'NETWORK_ERROR',
      `Could not prepare the 1688 host page for the plugin engine: ${(e as Error).message}`,
    );
  }
}

export async function getHostPage(ctx: BrowserContext): Promise<Page> {
  const cached = hostPages.get(ctx);
  if (cached && (await isHealthy(cached))) return cached;
  if (cached) await cached.close().catch(() => {});
  const page = await openHostPage(ctx);
  hostPages.set(ctx, page);
  return page;
}

export async function discardHostPage(ctx: BrowserContext): Promise<void> {
  const cached = hostPages.get(ctx);
  hostPages.delete(ctx);
  if (cached) await cached.close().catch(() => {});
}

export function pageTransport(page: Page): MtopTransport {
  return (spec) =>
    page.evaluate(async (req) => {
      type Cb = (res: { ret?: unknown; data?: unknown; api?: string; v?: string }) => void;
      const w = window as unknown as {
        lib?: {
          mtop?: {
            config?: Record<string, unknown>;
            request?: (params: Record<string, unknown>, ok: Cb, fail: Cb) => void;
          };
        };
      };
      const m = w.lib?.mtop;
      if (!m?.request) throw new Error('lib.mtop is not available on the host page');
      if (m.config) {
        m.config.prefix = 'h5api';
        m.config.mainDomain = '1688.com';
        m.config.subDomain = 'm';
      }
      return new Promise<{ ret?: unknown; data?: unknown; api?: string; v?: string }>(
        (resolve) => {
          const done: Cb = (res) =>
            resolve({ ret: res?.ret, data: res?.data, api: res?.api, v: res?.v });
          m.request!(
            {
              dataType: 'json',
              api: req.api,
              v: req.v,
              type: req.type,
              data: req.data,
              customConfig: { NeedAuthToken: false },
              headers: { 'X-Accept-Language': 'zh-CN' },
            },
            done,
            done,
          );
        },
      );
    }, spec);
}

export interface PluginExecuteArgs extends PluginSearchArgs {
  headed?: boolean;
}

// Errors after which the cached host page must not be reused: the session is
// gone, or 1688 wants a human to solve a challenge on a fresh page.
const DISCARD_HOST_PAGE_CODES = new Set(['RISK_CONTROL', 'NOT_LOGGED_IN']);

export async function execute(
  ctx: BrowserContext,
  args: PluginExecuteArgs,
): Promise<PluginSearchResult> {
  await pacePluginCall();
  try {
    return await withRecovery(
      ctx,
      { cmd: 'image-search', args },
      async () => {
        const page = await getHostPage(ctx);
        try {
          return await runPluginSearch(pageTransport(page), args);
        } catch (e) {
          if (e instanceof CliError && DISCARD_HOST_PAGE_CODES.has(e.code)) {
            await discardHostPage(ctx);
          }
          throw e;
        }
      },
      // No automatic retry: a risk-control or login failure must surface
      // immediately so the caller (and the daemon health pause) can react.
      { headed: args.headed === true, maxRetries: 0 },
    );
  } finally {
    markPluginCallEnded();
  }
}
