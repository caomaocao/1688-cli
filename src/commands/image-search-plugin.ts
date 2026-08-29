// `image-search --engine plugin`: drive 1688's image search through the two
// mtop calls the official "1688官方采购助手" extension uses for 找同款, instead of
// scraping the upload + results pages.
//
// Layout:
//   mapPluginOffer / mapPluginPage    — server item -> Offer + `plugin` block
//                                       (the JSON contract, kept with the command)
//   runPluginSearch(transport, args)  — the whole flow (upload → pages → map →
//                                       truncate), browser-free; unit-tested
//                                       with a fake transport.
//   pageTransport(page)               — MtopTransport backed by
//                                       window.lib.mtop.request on a 1688 page.
//   getHostPage / openHostPage        — hidden host page that hosts lib.mtop:
//                                       cached per context in daemon mode,
//                                       fresh and visible with --headed.
//   execute(ctx, args)                — daemon/inline entry point.

import fs from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import { CliError } from '../io/errors.js';
import { info } from '../io/output.js';
import { detectPageState, type PageStateKind } from '../session/page-state.js';
import { withRecovery } from '../session/recovery.js';
import { sleep } from '../session/wait.js';
import {
  PLUGIN_HOST_PAGE_URL,
  PLUGIN_MAX_BASE64_BYTES,
  PLUGIN_PAGE_SIZE,
  base64LengthOf,
  buildSearchRequest,
  buildUploadRequest,
  classifyMtopRet,
  mtopChallengeUrl,
  mtopRetCode,
  pagesFor,
  parseSearchResponse,
  parseUploadResponse,
  type MtopEnvelope,
  type MtopFailureKind,
  mtopTimeoutEnvelope,
  type MtopRequestSpec,
  type PluginOfferExtend,
  type PluginRawOfferItem,
  type PluginSearchPage,
} from '../session/plugin-image-search.js';
import type { Offer } from '../session/search-mtop.js';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type MtopTransport = (spec: MtopRequestSpec) => Promise<MtopEnvelope>;

// The plugin-only options, carried as one unit from the CLI flags through the
// daemon args to the search.
export interface PluginSearchFlags {
  region: string | null;
  imageId: string | null;
  raw: boolean;
}

export const NO_PLUGIN_FLAGS: PluginSearchFlags = { region: null, imageId: null, raw: false };

export interface PluginSearchArgs extends Partial<PluginSearchFlags> {
  imagePath?: string | null;
  max: number;
}

export interface PluginOfferBlock {
  stats: {
    saleQuantity: number | null;
    bookedCount: number | null;
    payOrderCount30d: number | null;
    payItemCount30d: number | null;
    quantitySumMonth: number | null;
    buyerCount: number | null;
    sales90: number | null;
    sales360: number | null;
    gmv: number | null;
    repurchaseRate: number | null;
    inquiryUv: number | null;
    evaluateCount: number | null;
  };
  shop: {
    memberId: string | null;
    loginId: string | null;
    url: string | null;
    creditLevel: number | null;
    creditLevelText: string | null;
    regCapital: string | null;
    shopRepurchaseRate: number | null;
    tpYear: number | null;
    isFactory: boolean;
    goldSupplier: boolean;
    compositeScore: number | null;
    goodsScore: number | null;
    logisticsScore: number | null;
    consultationScore: number | null;
    disputeScore: number | null;
  };
  price: {
    price: number | null;
    consignPrice: number | null;
    priceUnderLine: number | null;
    priceType: string | null;
    quantityBegin: number | null;
    unit: string | null;
  };
  images: string[];
  freight: { free: boolean | null; cost: number | null };
  categoryId: string | null;
  brand: string | null;
  attributes: Record<string, string>;
  service: {
    sevenDaysReturn: boolean;
    sevenDaysRefund: boolean;
    freightInsurance: boolean;
    mixWholesale: boolean;
    deliveryHours: number | null;
  };
  sameDesignCount: number | null;
  saleStats: Record<string, unknown> | null;
  shopInfo: Record<string, unknown> | null;
  raw?: unknown;
}

export interface PluginOffer extends Offer {
  plugin: PluginOfferBlock;
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

// ---------------------------------------------------------------------------
// Offer mapping
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[,+\s]/g, '');
    if (!cleaned || !/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function percent(v: unknown): number | null {
  if (typeof v === 'string' && v.includes('%')) return num(v.replace('%', ''));
  const n = num(v);
  if (n === null) return null;
  // Ratios like "0.4545" -> 45.45
  return n <= 1 ? Math.round(n * 10000) / 100 : n;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}

export function mapPluginOffer(
  item: PluginRawOfferItem,
  extend: PluginOfferExtend | undefined,
  opts: { raw?: boolean } = {},
): PluginOffer | null {
  const idRaw = item.id;
  const offerId =
    typeof idRaw === 'number' ? String(idRaw) : typeof idRaw === 'string' ? idRaw : '';
  if (!/^\d+$/.test(offerId)) return null;

  const info = item.information ?? {};
  const company = item.company ?? {};
  const tq = item.tradeQuantity ?? {};
  const ts = item.tradeService ?? {};
  const op = item.tradePrice?.offerPrice ?? {};
  const pi = op.priceInfo ?? {};

  const title = stripHtml(info.subject ?? info.simpleSubject ?? '');
  const priceText = str(pi.price) ?? str(op.valueString);
  const price = num(priceText);
  const years = num(ts.tpYear);
  const isFactory = company.isFactory === 'Y' || ts.factoryInspection === true;

  const orderCount = num(tq.bookedCount) ?? num(tq.saleQuantity);
  const repurchaseRate = percent(company.shopRepurchaseRate);
  const tags = Object.values(item.commonPositionLabels ?? {})
    .flat()
    .map((t) => t?.text?.trim() ?? '')
    .filter(Boolean);

  const attributes: Record<string, string> = {};
  for (const pair of info.propertyValueModel?.propertyValuePairs ?? []) {
    if (pair?.pValue && pair?.vValue) attributes[pair.pValue] = pair.vValue;
  }

  const freightCost = extend?.deliveryChargeInfo?.costs?.[0]?.totalCost;
  const regCapital =
    company.regCapital !== undefined && company.regCapital !== null
      ? `${company.regCapital}${company.regCapitalUnit ?? ''}`
      : null;

  const block: PluginOfferBlock = {
    stats: {
      saleQuantity: num(tq.saleQuantity),
      bookedCount: num(tq.bookedCount),
      payOrderCount30d: num(tq.payOrderCount30d),
      payItemCount30d: num(tq.payItemCount30d),
      quantitySumMonth: num(tq.quantitySumMonth),
      buyerCount: num(tq.buyerCount),
      sales90: num(tq.vaSales90),
      sales360: num(tq.vaSales360),
      gmv: num(tq.gmvValue?.integer),
      repurchaseRate: percent(info.rePurchaseRate),
      inquiryUv: num(info.byrInquiryUv),
      evaluateCount: num(info.evaluateCount),
    },
    shop: {
      memberId: str(company.memberId),
      loginId: str(item.aliTalk?.loginId),
      url: str(company.url),
      creditLevel: num(company.creditLevel),
      creditLevelText: str(company.creditLevelText),
      regCapital,
      shopRepurchaseRate: repurchaseRate,
      tpYear: years,
      isFactory,
      goldSupplier: ts.goldSupplier === true,
      compositeScore: num(ts.compositeNewScore) ?? num(ts.compositeScore),
      goodsScore: num(ts.goodsScore),
      logisticsScore: num(ts.logisticsScore),
      consultationScore: num(ts.consultationScore),
      disputeScore: num(ts.disputeScore),
    },
    price: {
      price,
      consignPrice: num(pi.consignPrice),
      priceUnderLine: num(pi.priceUnderLine),
      priceType: str(pi.priceType),
      quantityBegin: num(tq.quantityBegin),
      unit: str(tq.unit) ?? str(tq.sellUnit),
    },
    images: Array.isArray(extend?.images)
      ? extend.images.filter((u): u is string => typeof u === 'string' && !!u)
      : [],
    freight: {
      free:
        typeof item.tradePrice?.freightPrice?.free === 'boolean'
          ? item.tradePrice.freightPrice.free
          : null,
      cost: num(freightCost),
    },
    categoryId: info.categoryId !== undefined ? String(info.categoryId) : null,
    brand: str(item.brand?.name),
    attributes,
    service: {
      sevenDaysReturn: ts.sevenDaysReturn === true,
      sevenDaysRefund: ts.sevenDaysRefund === true,
      freightInsurance: ts.freightInsurance === true,
      mixWholesale: ts.mixWholesale === true,
      deliveryHours: num(ts.deliveryHours),
    },
    sameDesignCount: item.sameAndSimilarDesign?.sameDesign?.enable
      ? num(item.sameAndSimilarDesign.sameDesign.count)
      : null,
    saleStats: extend?.saleStatsModel ?? null,
    shopInfo: extend?.shopInfoModel ?? null,
  };
  if (opts.raw) block.raw = { item, extend: extend ?? null };

  return {
    offerId,
    title,
    price: {
      text: priceText ? `¥${priceText}` : '',
      min: price,
      max: price,
    },
    supplier: {
      name: str(company.name) ?? str(company.hoverName),
      shopUrl: str(company.url),
      years,
    },
    location: {
      province: str(company.province),
      city: str(company.city),
    },
    bizType: str(company.bizTypeName),
    verified: {
      factory: ts.factoryInspection === true,
      business: ts.businessInspection === true,
      superFactory: company.isSuperFactory === true,
    },
    tags,
    demand: {
      orderCountText: orderCount === null ? null : String(orderCount),
      orderCount,
      repurchaseRateText: str(company.shopRepurchaseRate),
      repurchaseRate,
    },
    isP4P: false,
    turnover: orderCount === null ? null : `${orderCount}${str(tq.unit) ?? ''}`,
    url: `https://detail.1688.com/offer/${offerId}.html`,
    image: str(item.image?.imgUrl),
    plugin: block,
  };
}

export function mapPluginPage(
  page: PluginSearchPage,
  opts: { raw?: boolean } = {},
): PluginOffer[] {
  const out: PluginOffer[] = [];
  for (const item of page.offers) {
    const id = item.id === undefined ? '' : String(item.id);
    const mapped = mapPluginOffer(item, page.offerExtend[id], opts);
    if (mapped) out.push(mapped);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

// One table for the three failure classes: exit code / CLI code, whether the
// cached host page must be thrown away, and the message variants.
const MTOP_FAILURES: Record<
  Exclude<MtopFailureKind, 'ok'>,
  { exitCode: number; code: string; category: string; discardHostPage: boolean }
> = {
  risk_control: { exitCode: 4, code: 'RISK_CONTROL', category: 'risk_challenge', discardHostPage: true },
  not_logged_in: { exitCode: 3, code: 'NOT_LOGGED_IN', category: 'not_logged_in', discardHostPage: true },
  upstream: { exitCode: 9, code: 'UPSTREAM_ERROR', category: 'upstream', discardHostPage: false },
  // No callback from lib.mtop at all: the host page may be wedged, so it is
  // thrown away and the next call starts from a fresh one.
  timeout: { exitCode: 9, code: 'MTOP_TIMEOUT', category: 'upstream', discardHostPage: true },
};

// How long one mtop request (upload or search) may take before the transport
// gives up. Normal calls finish in 2–5 s; the daemon must never wait forever
// because its shared context runs commands serially. Budget: upload + first
// page = 2 × (40 + 10) s = 100 s, inside a 180 s client-side timeout.
export const PLUGIN_MTOP_TIMEOUT_MS = 40_000;
// Extra slack for the Node-side race: if even the in-page timer cannot fire
// (renderer frozen) the evaluate itself is abandoned.
export const PLUGIN_MTOP_TIMEOUT_MARGIN_MS = 10_000;

const RISK_HINT_HEADLESS =
  '1688 returned a verification challenge for the plugin engine. Retry once with `--headed`, solve the slider, then continue.';
const RISK_HINT_HEADED =
  'Slider verification was not solved in time. Rerun with `--headed` and complete the check in the browser window.';

export function shouldDiscardHostPage(code: string): boolean {
  return Object.values(MTOP_FAILURES).some((f) => f.code === code && f.discardHostPage);
}

// Maps a non-success mtop `ret` (or a host-page state) onto the CLI's error
// vocabulary. RISK_CONTROL / NOT_LOGGED_IN are the codes the shared recovery
// layer already understands, so daemon health accounting and the `--headed`
// hint apply unchanged.
export function mtopFailure(
  ret: string,
  stage: 'upload' | 'search' | 'host-page',
  opts: { headed?: boolean } = {},
): CliError {
  const kind = classifyMtopRet(ret);
  const shown = ret || 'empty mtop response';
  const f = MTOP_FAILURES[kind === 'ok' ? 'upstream' : kind];
  switch (f.code) {
    case 'RISK_CONTROL':
      return new CliError(
        f.exitCode,
        f.code,
        opts.headed
          ? `1688 risk control blocked the image search (${stage}): ${shown}. ${RISK_HINT_HEADED}`
          : `1688 risk control blocked the image search (${stage}): ${shown}. Run once with \`--headed\` to solve the verification manually.`,
        {
          ret,
          stage,
          category: f.category,
          recoverHint: opts.headed ? RISK_HINT_HEADED : RISK_HINT_HEADLESS,
          retryable: false,
        },
      );
    case 'NOT_LOGGED_IN':
      return new CliError(
        f.exitCode,
        f.code,
        `1688 session expired during image search (${stage}): ${shown}. Run \`1688 login\`.`,
        { ret, stage, category: f.category, retryable: false },
      );
    case 'MTOP_TIMEOUT':
      return new CliError(
        f.exitCode,
        f.code,
        `1688 image search (${stage}) got no response from lib.mtop: ${shown}. The host page was discarded; retry the call.`,
        {
          ret,
          stage,
          category: f.category,
          retryable: true,
          recoverHint: 'Retry once. If it keeps timing out, run `1688 daemon reload --profile <profile>`.',
        },
      );
    default:
      return new CliError(f.exitCode, f.code, `1688 image search (${stage}) failed: ${shown}`, {
        ret,
        stage,
        category: f.category,
      });
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

// Cheap size gate (stat only) so a doomed call never pays for pacing or a page
// load. Used by the CLI before dispatch and by the executor before pacing.
export async function assertImageWithinCap(imagePath: string): Promise<void> {
  let size: number;
  try {
    size = (await fs.stat(imagePath)).size;
  } catch {
    throw new CliError(2, 'BAD_INPUT', `Cannot read image: ${imagePath}`);
  }
  if (size === 0) throw new CliError(2, 'BAD_INPUT', `Image is empty: ${imagePath}`);
  const b64 = base64LengthOf(size);
  if (b64 > PLUGIN_MAX_BASE64_BYTES) {
    throw new CliError(
      2,
      'BAD_INPUT',
      `Image too large for the plugin engine (${(b64 / 1024 / 1024).toFixed(1)}MB base64 > 4MB). Shrink it first; the engine does not resize so --region stays 1:1 with your file.`,
    );
  }
}

async function readImageBase64(imagePath: string): Promise<string> {
  await assertImageWithinCap(imagePath);
  try {
    return (await fs.readFile(imagePath)).toString('base64');
  } catch {
    throw new CliError(2, 'BAD_INPUT', `Cannot read image: ${imagePath}`);
  }
}

// ---------------------------------------------------------------------------
// Search flow
// ---------------------------------------------------------------------------

export interface PluginSearchHooks {
  // Wait between consecutive page requests. Injectable so tests run instantly.
  pageGap?: () => Promise<void>;
  // Called on a risk-control reply. Return true once the challenge has been
  // solved to retry that request exactly once; false/absent → fail.
  onRiskControl?: (env: MtopEnvelope, stage: 'upload' | 'search') => Promise<boolean>;
  headed?: boolean;
}

const PAGE_GAP_MS: [number, number] = [2000, 4000];

function randomBetween([lo, hi]: [number, number]): number {
  return lo + Math.floor(Math.random() * (hi - lo));
}

async function defaultPageGap(): Promise<void> {
  await sleep(randomBetween(PAGE_GAP_MS));
}

async function call(
  transport: MtopTransport,
  spec: MtopRequestSpec,
  stage: 'upload' | 'search',
  hooks: PluginSearchHooks,
): Promise<MtopEnvelope> {
  let env = await transport(spec);
  let ret = mtopRetCode(env);
  if (classifyMtopRet(ret) === 'risk_control' && hooks.onRiskControl) {
    const solved = await hooks.onRiskControl(env, stage);
    if (solved) {
      env = await transport(spec);
      ret = mtopRetCode(env);
    }
  }
  if (classifyMtopRet(ret) !== 'ok') throw mtopFailure(ret, stage, { headed: hooks.headed });
  return env;
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
    const env = await call(transport, buildUploadRequest(b64), 'upload', hooks);
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
    const env = await call(
      transport,
      buildSearchRequest({ imageId, beginPage: page, region: args.region ?? null }),
      'search',
      hooks,
    );
    pagesFetched = page;
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
// Pacing
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Host page
// ---------------------------------------------------------------------------

const HOST_PAGE_READY_TIMEOUT_MS = 20000;
const CHALLENGE_SOLVE_TIMEOUT_MS = 180000;
const CHALLENGE_POLL_MS = 1000;

// Single source for "is lib.mtop usable here" — passed to both evaluate and
// waitForFunction (Playwright serialises the function source).
const mtopReady = (): boolean => {
  const w = window as unknown as { lib?: { mtop?: { request?: unknown } } };
  return typeof w.lib?.mtop?.request === 'function';
};

const hostPages = new WeakMap<BrowserContext, Page>();

async function hasMtop(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(mtopReady);
  } catch {
    return false;
  }
}

async function pageStateKind(page: Page): Promise<PageStateKind> {
  return (await detectPageState(page).catch(() => null))?.kind ?? 'unknown';
}

async function isHealthy(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  if ((await pageStateKind(page)) !== 'normal_1688_page') return false;
  return hasMtop(page);
}

// `--headed`: give the user time to solve the slider in the visible window.
async function waitForChallengeSolved(page: Page): Promise<void> {
  info('1688 is showing a verification challenge. Solve it in the browser window...');
  const deadline = Date.now() + CHALLENGE_SOLVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new CliError(130, 'CANCELED', 'Browser closed.');
    const kind = await pageStateKind(page);
    if (kind === 'not_logged_in') {
      throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
    }
    if (kind === 'normal_1688_page') {
      info('Verification solved. Continuing...');
      return;
    }
    await sleep(CHALLENGE_POLL_MS);
  }
  throw mtopFailure('RGV587_ERROR::SM', 'host-page', { headed: true });
}

async function prepareHostPage(page: Page, headed: boolean): Promise<void> {
  await page.goto(PLUGIN_HOST_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const kind = await pageStateKind(page);
  if (kind === 'not_logged_in') {
    throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
  }
  if (kind === 'risk_challenge') {
    if (!headed) throw mtopFailure('RGV587_ERROR::SM', 'host-page');
    await waitForChallengeSolved(page);
    if (!/air\.1688\.com\/kapp\/innovateHub/.test(page.url())) {
      await page.goto(PLUGIN_HOST_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
  }
  try {
    await page.waitForFunction(mtopReady, undefined, { timeout: HOST_PAGE_READY_TIMEOUT_MS });
  } catch (e) {
    throw new CliError(
      9,
      'NETWORK_ERROR',
      `Could not prepare the 1688 host page for the plugin engine (lib.mtop not ready): ${(e as Error).message}`,
    );
  }
}

export async function openHostPage(
  ctx: BrowserContext,
  opts: { headed?: boolean } = {},
): Promise<Page> {
  const page = await ctx.newPage();
  try {
    await prepareHostPage(page, opts.headed === true);
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

// Headed risk-control handler: open the challenge 1688 pointed at (or reload
// the host page), wait for the user, then bring lib.mtop back.
function headedRiskHandler(page: Page): PluginSearchHooks['onRiskControl'] {
  return async (env) => {
    const url = mtopChallengeUrl(env);
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    else await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForChallengeSolved(page);
    await page.goto(PLUGIN_HOST_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(mtopReady, undefined, { timeout: HOST_PAGE_READY_TIMEOUT_MS });
    return true;
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function pageTransport(
  page: Page,
  timeoutMs: number = PLUGIN_MTOP_TIMEOUT_MS,
  marginMs: number = PLUGIN_MTOP_TIMEOUT_MARGIN_MS,
): MtopTransport {
  return (spec) => {
    const inPage = page.evaluate(async (req) => {
      // Mirrors the extension's mtop wrapper (203.js module 16211): config
      // prefix/mainDomain/subDomain, `customConfig.NeedAuthToken` (false on
      // the token-less v1.0 path) and the X-Accept-Language header.
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
          // lib.mtop sometimes never calls either callback; bound the wait.
          setTimeout(
            () => resolve({ ret: [`MTOP_TIMEOUT::no mtop callback within ${req.timeoutMs}ms`] }),
            req.timeoutMs,
          );
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
    }, { ...spec, timeoutMs });
    // Second line of defence: a frozen renderer would never run the in-page timer.
    let timer: NodeJS.Timeout | undefined;
    const abandoned = new Promise<MtopEnvelope>((resolve) => {
      timer = setTimeout(
        () => resolve(mtopTimeoutEnvelope(`page.evaluate did not return within ${timeoutMs + marginMs}ms`)),
        timeoutMs + marginMs,
      );
    });
    return Promise.race([inPage, abandoned]).finally(() => clearTimeout(timer));
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface PluginExecuteArgs extends PluginSearchArgs {
  headed?: boolean;
}

export async function execute(
  ctx: BrowserContext,
  args: PluginExecuteArgs,
): Promise<PluginSearchResult> {
  const headed = args.headed === true;
  if (args.imagePath && !args.imageId) await assertImageWithinCap(args.imagePath);
  await pacePluginCall();
  try {
    return await withRecovery(
      ctx,
      { cmd: 'image-search', args },
      async () => {
        // Headed: a fresh, visible page per call so the user can solve a
        // slider; closed afterwards. Otherwise the cached hidden host page.
        const page = headed ? await openHostPage(ctx, { headed }) : await getHostPage(ctx);
        try {
          return await runPluginSearch(pageTransport(page), args, {
            headed,
            onRiskControl: headed ? headedRiskHandler(page) : undefined,
          });
        } catch (e) {
          if (!headed && e instanceof CliError && shouldDiscardHostPage(e.code)) {
            await discardHostPage(ctx);
          }
          throw e;
        } finally {
          if (headed) await page.close().catch(() => {});
        }
      },
      // No automatic retry: a risk-control or login failure must surface
      // immediately so the caller (and the daemon health pause) can react.
      { headed, maxRetries: 0 },
    );
  } finally {
    markPluginCallEnded();
  }
}
