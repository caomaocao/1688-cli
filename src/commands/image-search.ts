import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { BrowserContext } from 'playwright';
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import {
  clickImageSearchButton,
  clickImageUploadButton,
} from '../session/image-search-locators.js';
import { captureSearchOffersForAction } from '../session/search-capture.js';
import {
  PLUGIN_DEFAULT_MAX,
  PLUGIN_MAX_RESULTS,
  normalizeRegion,
} from '../session/plugin-image-search.js';
import {
  NO_PLUGIN_FLAGS,
  assertImageWithinCap,
  type PluginOffer,
  type PluginSearchFlags,
} from './image-search-plugin.js';
import { type Offer } from './search.js';

export type ImageSearchEngine = 'page' | 'plugin';
export const IMAGE_SEARCH_ENGINES: readonly ImageSearchEngine[] = ['page', 'plugin'];

export interface ImageSearchOpts {
  imagePath?: string;
  max?: string;
  profile?: string;
  headed?: boolean;
  engine?: string;
  // --engine plugin only:
  region?: string;
  imageId?: string;
  raw?: boolean;
}

export interface ImageSearchArgs {
  // null only with `--engine plugin --image-id` (nothing to upload).
  imagePath: string | null;
  max: number;
  headed?: boolean;
  // `page` (default) scrapes the upload + results pages; `plugin` drives the
  // official 采购助手 extension's mtop calls. See image-search-plugin.ts.
  engine?: ImageSearchEngine;
  // --engine plugin only. `region` is 1688's native "x1,x2,y1,y2" (pixels of
  // the uploaded file); `imageId` reuses an earlier upload (imagePath is then
  // null); `raw` attaches the untouched server item to each offer.
  plugin?: PluginSearchFlags;
}

// The page engine's args once the image path has been validated.
type PageSearchArgs = ImageSearchArgs & { imagePath: string };

const PLUGIN_ONLY_FLAGS: ReadonlyArray<[keyof ImageSearchOpts, string]> = [
  ['region', '--region'],
  ['imageId', '--image-id'],
  ['raw', '--raw'],
];

export interface ImageSearchResult {
  imageId: string;
  total: number;
  offers: Offer[];
  // Present only for `--engine plugin`.
  engine?: ImageSearchEngine;
  region?: string | null;
  yoloCropRegion?: string[];
  pagesFetched?: number;
}

export function parseEngine(raw: string | undefined): ImageSearchEngine {
  const value = (raw ?? 'page').trim().toLowerCase();
  if ((IMAGE_SEARCH_ENGINES as readonly string[]).includes(value)) {
    return value as ImageSearchEngine;
  }
  throw new CliError(
    2,
    'BAD_INPUT',
    `Unknown --engine "${raw}". Use one of: ${IMAGE_SEARCH_ENGINES.join(', ')}.`,
  );
}

// Upload entry point. 1688 currently redirects this to the pc-image-search app
// on air.1688.com, and after "搜索图片" the page lands on a URL carrying
// `imageId=<digits>` — that is where uploadAndGetImageId reads the id from.
export const IMAGE_SEARCH_UPLOAD_URL = 'https://s.1688.com/youyuan/index.htm';

// Results page for an already-uploaded imageId.
//
// Do NOT use the legacy `s.1688.com/selloffer/offer_search.htm?imageId=...`
// URL here: 1688 now ignores `imageId` on that page and renders the ordinary
// keyword-search shell with an empty query. Its getOfferList mtop call then
// returns a personalised "猜你喜欢" feed, so every image produced the same 60
// unrelated offers. The pc-image-search app instead fires appId=32517
// recommend calls with the imageId in their params (see
// IMAGE_SEARCH_RESULT_METHODS); the response has the same
// `data.data.OFFER.items` shape our parser expects.
export function imageSearchResultUrl(imageId: string): string {
  const id = encodeURIComponent(imageId);
  return `https://air.1688.com/kapp/1688-search/pc-image-search/?tab=imageSearch&imageId=${id}&imageIdList=${id}`;
}

// mtop `params.method` values that carry the image-search offer list on the
// results page. Observed sequence on a fresh imageId:
//   1. getImageSearchPreResult  → placeholder (`"mock":["mock"]`, no items)
//      while the server is still computing
//   2. imageOfferSearchService  → the real 60-offer list ~0.5s later
// On a later load of the same imageId the pre-result is cached server-side
// and getImageSearchPreResult itself returns the 60 offers, with no second
// call. Accept both; empty placeholder bodies are ignored by the capture.
// The page also fires other appId=32517 calls (behaviour reports, AI-assist
// streams, empty getOfferList probes), so the capture must stay scoped.
export const IMAGE_SEARCH_RESULT_METHODS = [
  'getImageSearchPreResult',
  'imageOfferSearchService',
] as const;

export async function execute(
  ctx: BrowserContext,
  args: ImageSearchArgs,
): Promise<ImageSearchResult> {
  if (args.engine === 'plugin') {
    const { execute: executePlugin } = await import('./image-search-plugin.js');
    return executePlugin(ctx, {
      ...(args.plugin ?? NO_PLUGIN_FLAGS),
      imagePath: args.imagePath,
      max: args.max,
      headed: args.headed,
    });
  }

  if (!args.imagePath) {
    throw new CliError(2, 'BAD_INPUT', 'Image path or URL required.');
  }
  await assertReadable(args.imagePath);
  const pageArgs: PageSearchArgs = { ...args, imagePath: args.imagePath };

  return withRecovery(
    ctx,
    { cmd: 'image-search', args },
    () => executeImageSearch(ctx, pageArgs),
    { headed: args.headed === true, maxRetries: 1 },
  );
}

async function assertReadable(imagePath: string): Promise<void> {
  try {
    await fs.access(imagePath, fs.constants.R_OK);
  } catch {
    throw new CliError(2, 'BAD_INPUT', `Cannot read image: ${imagePath}`);
  }
}

async function executeImageSearch(
  ctx: BrowserContext,
  args: PageSearchArgs,
): Promise<ImageSearchResult> {
  info('Uploading image to 1688...');
  const imageId = await uploadAndGetImageId(ctx, args.imagePath);
  info(`Image uploaded (imageId=${imageId}). Fetching results...`);

  const offers = await searchByImageId(ctx, imageId);
  return {
    imageId,
    total: offers.length,
    offers: offers.slice(0, args.max),
  };
}

async function uploadAndGetImageId(
  ctx: BrowserContext,
  imagePath: string,
): Promise<string> {
  const page = await ctx.newPage();
  try {
    page.on('filechooser', async (chooser) => {
      try {
        await chooser.setFiles(imagePath);
      } catch {
        /* ignore — handled by waitForURL timeout */
      }
    });

    await page.goto(IMAGE_SEARCH_UPLOAD_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    if (/login\.1688\.com|login\.taobao\.com/.test(page.url())) {
      throw new CliError(
        3,
        'NOT_LOGGED_IN',
        'Session expired. Run `1688 login`.',
      );
    }

    await clickImageUploadButton(page);

    await Promise.all([
      page
        .waitForURL(/imageId=\d+/, { timeout: 20000 })
        .catch(() => undefined),
      clickImageSearchButton(page),
    ]);

    const match = page.url().match(/imageId=(\d+)/);
    if (!match) {
      throw new CliError(
        13,
        'UPLOAD_FAILED',
        'No imageId in URL after upload. Try again or use --headed.',
      );
    }
    return match[1]!;
  } finally {
    await page.close().catch(() => {});
  }
}

async function searchByImageId(
  ctx: BrowserContext,
  imageId: string,
): Promise<Offer[]> {
  const page = await ctx.newPage();

  try {
    const captureResult = await captureSearchOffersForAction(
      { page, keep: 'largest', requireMethod: IMAGE_SEARCH_RESULT_METHODS },
      async () => {
        await page.goto(imageSearchResultUrl(imageId), {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      },
      {
        timeoutMs: 15000,
        isClosed: () => page.isClosed(),
        isBlocked: () => /\/punish|x5secdata=/.test(page.url()),
      },
    );
    if (process.env.BB1688_DEBUG === '1') {
      process.stderr.write(
        `[image-search] capture status=${captureResult.status} url=${page.url()} ` +
          `diagnostics=${JSON.stringify(captureResult.diagnostics)}\n`,
      );
    }
    if (captureResult.status === 'browser_closed') {
      throw new CliError(130, 'CANCELED', 'Browser closed.');
    }
    return captureResult.offers;
  } finally {
    await page.close().catch(() => {});
  }
}

// `--max` per engine. The page engine keeps its lenient historical parsing
// (default 20, no cap); the plugin engine is strict: integer 1..200, default
// one server page. (`sourcing-utils.parsePositiveInt` clamps instead of
// rejecting and accepts "2.5", so it is not reused here on purpose.)
export function parseMax(engine: ImageSearchEngine, raw: string | undefined): number {
  if (engine !== 'plugin') return Math.max(1, parseInt(raw ?? '20', 10));
  const maxRaw = raw ?? String(PLUGIN_DEFAULT_MAX);
  const max = /^\d+$/.test(maxRaw.trim()) ? Number(maxRaw.trim()) : NaN;
  if (!Number.isInteger(max) || max < 1 || max > PLUGIN_MAX_RESULTS) {
    throw new CliError(
      2,
      'BAD_INPUT',
      `--max must be an integer between 1 and ${PLUGIN_MAX_RESULTS} with --engine plugin (got "${maxRaw}").`,
    );
  }
  return max;
}

// Validates the plugin-only flags (`--region`, `--image-id`, `--raw`): they
// are rejected under the page engine and normalised under the plugin engine.
export function parsePluginFlags(
  engine: ImageSearchEngine,
  opts: ImageSearchOpts,
): PluginSearchFlags {
  if (engine !== 'plugin') {
    for (const [key, flag] of PLUGIN_ONLY_FLAGS) {
      if (opts[key] !== undefined && opts[key] !== false) {
        throw new CliError(2, 'BAD_INPUT', `${flag} requires --engine plugin.`);
      }
    }
    return NO_PLUGIN_FLAGS;
  }

  let region: string | null = null;
  if (opts.region !== undefined) {
    region = normalizeRegion(opts.region);
    if (!region) {
      throw new CliError(
        2,
        'BAD_INPUT',
        `Invalid --region "${opts.region}". Expected 1688's native "x1,x2,y1,y2" (integers, x2 > x1, y2 > y1, pixels of the uploaded image).`,
      );
    }
  }

  let imageId: string | null = null;
  if (opts.imageId !== undefined) {
    const id = opts.imageId.trim();
    if (!/^\d+$/.test(id)) {
      throw new CliError(2, 'BAD_INPUT', `Invalid --image-id "${opts.imageId}": expected digits.`);
    }
    imageId = id;
  }

  return { region, imageId, raw: opts.raw === true };
}

export async function run(opts: ImageSearchOpts): Promise<void> {
  const engine = parseEngine(opts.engine);
  const flags = parsePluginFlags(engine, opts);
  const max = parseMax(engine, opts.max);
  if (!opts.imagePath && !flags.imageId) {
    throw new CliError(
      2,
      'BAD_INPUT',
      engine === 'plugin'
        ? 'Image path or URL required (or --image-id to reuse an upload).'
        : 'Image path or URL required.',
    );
  }

  let abs: string | null = null;
  let cleanup: (() => Promise<void>) | null = null;
  // With --image-id the file is not uploaded, so it is not even read.
  if (opts.imagePath && !flags.imageId) {
    if (/^https?:\/\//i.test(opts.imagePath)) {
      info(`Downloading image from URL...`);
      const t = await downloadToTemp(opts.imagePath);
      abs = t.path;
      cleanup = t.cleanup;
    } else {
      abs = path.resolve(opts.imagePath);
    }
  }

  try {
    // Plugin engine: fail on an oversize file before dispatch, so a doomed
    // call never pays for pacing or a host-page load.
    if (engine === 'plugin' && abs) await assertImageWithinCap(abs);
    const data = await dispatch<ImageSearchArgs, ImageSearchResult>(
      'image-search',
      {
        imagePath: abs,
        max,
        headed: opts.headed,
        engine,
        ...(engine === 'plugin' ? { plugin: flags } : {}),
      },
      { headed: opts.headed, profile: opts.profile },
    );
    emit({
      human: () => printResults(data),
      data,
    });
  } finally {
    if (cleanup) await cleanup().catch(() => {});
  }
}

interface TempFile {
  path: string;
  cleanup: () => Promise<void>;
}

async function downloadToTemp(url: string): Promise<TempFile> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new CliError(
      9,
      'NETWORK_ERROR',
      `Failed to download image: ${(e as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new CliError(
      9,
      'NETWORK_ERROR',
      `Download failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new CliError(9, 'NETWORK_ERROR', 'Downloaded image is empty.');
  }
  if (buf.length > 20 * 1024 * 1024) {
    throw new CliError(
      2,
      'BAD_INPUT',
      `Image too large (${(buf.length / 1024 / 1024).toFixed(1)}MB > 20MB).`,
    );
  }
  const ext = guessExt(url, res.headers.get('content-type'));
  const tmpPath = path.join(
    os.tmpdir(),
    `bb1688-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  );
  await fs.writeFile(tmpPath, buf);
  return {
    path: tmpPath,
    cleanup: () => fs.rm(tmpPath, { force: true }),
  };
}

function guessExt(url: string, contentType: string | null): string {
  const m = url.match(/\.(jpe?g|png|webp|bmp)(\?|$|#)/i);
  if (m) return '.' + m[1]!.toLowerCase().replace('jpeg', 'jpg');
  if (contentType) {
    if (/jpeg/i.test(contentType)) return '.jpg';
    if (/png/i.test(contentType)) return '.png';
    if (/webp/i.test(contentType)) return '.webp';
    if (/bmp/i.test(contentType)) return '.bmp';
  }
  return '.jpg';
}

// Extra line for `--engine plugin` results: 30-day orders · repurchase · shop
// years. Exported for tests; returns '' for page-engine offers.
export function pluginSummaryLine(o: Offer | PluginOffer): string {
  if (!('plugin' in o) || !o.plugin) return '';
  const { stats, shop } = o.plugin;
  const bits = [
    stats.payOrderCount30d != null ? `30d单量 ${stats.payOrderCount30d}` : null,
    shop.shopRepurchaseRate != null ? `复购 ${shop.shopRepurchaseRate}%` : null,
    shop.tpYear != null ? `店龄 ${shop.tpYear}年` : null,
  ].filter(Boolean);
  return bits.join(' · ');
}

function printResults(r: ImageSearchResult): void {
  if (r.offers.length === 0) {
    process.stdout.write(`No offers found (imageId=${r.imageId}).\n`);
    return;
  }
  const header =
    r.engine === 'plugin'
      ? `Image search [plugin engine] (imageId=${r.imageId}, total≈${r.total}, region=${r.region ?? 'auto'}, pages=${r.pagesFetched ?? 1}):\n\n`
      : `Image search (imageId=${r.imageId}):\n\n`;
  process.stdout.write(header);
  const w = String(r.offers.length).length;
  r.offers.forEach((o, i) => {
    const idx = String(i + 1).padStart(w, ' ');
    const price = o.price.text || '(n/a)';
    process.stdout.write(`${idx}. ${o.title}\n`);
    const pad = ' '.repeat(w + 2);
    process.stdout.write(`${pad}${price}`);
    if (o.turnover) process.stdout.write(`  ·  ${o.turnover}`);
    process.stdout.write('\n');
    const supplierBits = [
      o.supplier.name,
      o.supplier.years ? `${o.supplier.years}年` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (supplierBits) process.stdout.write(`${pad}${supplierBits}\n`);
    const pluginLine = pluginSummaryLine(o);
    if (pluginLine) process.stdout.write(`${pad}${pluginLine}\n`);
    process.stdout.write(`${pad}${o.url}\n`);
    if (i < r.offers.length - 1) process.stdout.write('\n');
  });
}
