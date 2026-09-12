import type { BrowserContext, Page } from 'playwright';
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { encodeGbkPercent } from '../util/encoding.js';
import { debugTmpPath } from '../util/temp.js';
import { withRecovery } from '../session/recovery.js';
import { clickSearchNextPage } from '../session/search-locators.js';
import { startSearchOfferCapture } from '../session/search-capture.js';
import {
  SEARCH_APP_ID,
  SEARCH_MTOP_API,
  mapOffer,
  parseOfferItemsFromMtopText,
  readSearchMtopRequestMeta,
  type Offer,
  type RawOfferItem,
} from '../session/search-mtop.js';
import { parseMtopJsonp } from '../session/mtop.js';
import { sleep, waitWithDeadline } from '../session/wait.js';
import { detectPageState } from '../session/page-state.js';
import type { OfferResult, OfferArgs } from './offer.js';
import {
  applySearchControls,
  hasActiveFilters,
  normalizeFilters,
  normalizeSearchSort,
  normalizeVerifiedFilter,
  parseOptionalNumber,
  parsePositiveInt,
  type SearchFilterSummary,
  type SearchSort,
} from './sourcing-utils.js';

export interface SearchOpts {
  max?: string;
  sort?: string;
  priceMin?: string;
  priceMax?: string;
  province?: string;
  city?: string;
  verified?: string;
  minTurnover?: string;
  excludeAds?: boolean;
  deeppro?: boolean;
  deepproDelayMin?: string;
  deepproDelayMax?: string;
  profile?: string;
  headed?: boolean;
}

export interface SearchArgs {
  keyword: string;
  max: number;
  sort?: SearchSort;
  filters?: SearchFilterSummary;
  headed?: boolean;
}

export interface DeepProFailure {
  offerId: string;
  code: string;
  message: string;
  attempts: number;
}

export interface DeepProSummary {
  enabled: true;
  total: number;
  success: number;
  failed: number;
  offerIds: string[];
  offers: OfferResult[];
  failures: DeepProFailure[];
}

export interface SearchResult {
  keyword: string;
  sort: SearchSort;
  filters: SearchFilterSummary;
  totalBeforeFilter: number;
  total: number;
  offers: Offer[];
  deeppro?: DeepProSummary;
}

export type { Offer };

export async function execute(
  ctx: BrowserContext,
  args: SearchArgs,
): Promise<SearchResult> {
  return withRecovery(
    ctx,
    { cmd: 'search', args },
    async () => {
      const sort = args.sort ?? 'relevance';
      const filters = args.filters ?? normalizeFilters({});
      const fetchMax = hasActiveFilters(filters)
        ? Math.min(Math.max(args.max * 3, PAGE_SIZE), PAGE_SIZE * MAX_PAGES)
        : args.max;
      const offers = await fetchSearch(
        ctx,
        args.keyword,
        args.headed === true,
        fetchMax,
        sort,
      );
      const controlled = applySearchControls(offers, sort, filters);
      const slice = controlled.slice(0, args.max);
      return {
        keyword: args.keyword,
        sort,
        filters,
        totalBeforeFilter: offers.length,
        total: slice.length,
        offers: slice,
      };
    },
    { headed: args.headed === true, maxRetries: 1 },
  );
}

export async function run(keyword: string, opts: SearchOpts): Promise<void> {
  const kw = (keyword ?? '').trim();
  if (!kw) {
    throw new CliError(2, 'BAD_INPUT', 'Search keyword is required.');
  }
  const max = parsePositiveInt(opts.max, '--max', 20, PAGE_SIZE * MAX_PAGES);
  const sort = normalizeSearchSort(opts.sort);
  const filters = normalizeFilters({
    priceMin: parseOptionalNumber(opts.priceMin, '--price-min'),
    priceMax: parseOptionalNumber(opts.priceMax, '--price-max'),
    province: opts.province,
    city: opts.city,
    verified: normalizeVerifiedFilter(opts.verified),
    minTurnover: parseOptionalNumber(opts.minTurnover, '--min-turnover'),
    excludeAds: opts.excludeAds,
  });

  // --deeppro bypasses daemon for the initial search too, so DAEMON_PAUSED
  // can't block the search before deep collection even starts.
  const data = await dispatch<SearchArgs, SearchResult>(
    'search',
    { keyword: kw, max, sort, filters, headed: opts.headed },
    { headed: opts.headed, profile: opts.profile, noDaemon: opts.deeppro === true },
  );

  // --deeppro: deep collect each search result in pro inline mode.
  if (opts.deeppro === true) {
    const ids = data.offers
      .map((o) => String(o.offerId ?? '').trim())
      .filter((id) => /^\d+$/.test(id) && id !== '0');

    const delayMin = parsePositiveInt(opts.deepproDelayMin, '--deeppro-delay-min', 6, 120);
    const delayMax = parsePositiveInt(opts.deepproDelayMax, '--deeppro-delay-max', 10, 120);

    data.deeppro = await deepProCollect(ids, {
      headed: opts.headed,
      profile: opts.profile,
      delayMin,
      delayMax,
      maxRetries: 3,
    });
  }

  emit({
    human: () => printOffers(data),
    data,
  });
}

let HTML_SEQ = 0;
let MTOP_SEQ = 0;

export { SEARCH_APP_ID, SEARCH_MTOP_API, mapOffer };
export const SEARCH_WARMUP_URL = 'https://www.1688.com/';
// 1688 search returns 60 offers per page. `--max` auto-paginates by
// clicking the in-page "next" arrow (which keeps the search-context
// `pageId` stable — see fetchSearch for why that matters). MAX_PAGES caps
// it: each extra page is another click + mtop round-trip (~3-5s) and a bit
// more WAF exposure, so we stop at 10 pages (600 results) even if --max
// asks for more.
const PAGE_SIZE = 60;
const MAX_PAGES = 10;

export { parseMtopJsonp };

export type { RawOfferItem };

async function fetchSearch(
  ctx: BrowserContext,
  keyword: string,
  headed: boolean,
  maxResults: number,
  sort: SearchSort,
): Promise<Offer[]> {
  const page = await ctx.newPage();

  const baseUrl = buildSearchUrl(keyword, sort);
  const sortType = remoteSortType(sort);
  const pagesWanted = Math.min(
    Math.max(1, Math.ceil(maxResults / PAGE_SIZE)),
    MAX_PAGES,
  );

  // The search capture must only attach AFTER warmup: home/search pages can
  // fire recommendation mtop calls before the real search navigation. The
  // capture also checks beginPage so stale page-1 responses cannot poison later
  // pages.
  let currentTargetPage = 1;

  async function warmup(delayMs: number): Promise<void> {
    try {
      await page.goto(SEARCH_WARMUP_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await sleep(delayMs);
    } catch {
      /* best-effort */
    }
  }

  async function navigateTo(targetUrl: string): Promise<void> {
    try {
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (e) {
      throw new CliError(
        9,
        'NETWORK_ERROR',
        `Failed to load search page: ${(e as Error).message}`,
      );
    }
  }

  async function searchFromHomepageOrNavigate(): Promise<void> {
    if (shouldUseMainSiteSearchSubmit(sort)) {
      const submitted = await trySubmitSearchFromHomepage(page, keyword);
      if (submitted) return;
      info('Homepage search box unavailable — opening search results directly.');
    }
    await navigateTo(baseUrl);
  }

  async function searchThenSortOrNavigate(): Promise<void> {
    const submitted = await trySubmitSearchFromHomepage(page, keyword);
    if (submitted) {
      await sleep(1200);
      const sorted = await tryClickSearchSort(page, sort);
      if (sorted) return;
      info('Search sort control unavailable — opening sorted results directly.');
    } else {
      info('Homepage search box unavailable — opening sorted results directly.');
    }
    await navigateTo(baseUrl);
  }

  // Diagnostic: log every plausible data-bearing call fired during search,
  // plus inline-JSON markers in the HTML response. Set BB1688_PROBE=1.
  // Writes directly to stderr — `info()` is silenced in piped/JSON mode.
  if (process.env.BB1688_PROBE === '1') {
    const log = (line: string) => process.stderr.write(line + '\n');
    log('[probe] active');
    HTML_SEQ = 0;
    MTOP_SEQ = 0;
    page.on('response', async (resp) => {
      const u = resp.url();
      const ct = resp.headers()['content-type'] ?? '';
      if (
        /\.(png|jpg|jpeg|gif|webp|css|woff2?|svg|ico|mp4|ttf|otf|js|map)(\?|$)/i.test(
          u,
        )
      )
        return;
      // Skip well-known analytics noise.
      if (/google-analytics|baidu\.com\/hm\.js|alicdn\.com\/sufei/i.test(u))
        return;
      try {
        const path = new URL(u).pathname;
        const m = path.match(/mtop[.\/][^/?&]+/);
        if (m) {
          // For each mtop call, also extract appId (URL param) + response size.
          // Different appIds in WirelessRecommend.recommend separate
          // main-search vs related-products vs banner content.
          const qs = new URL(u).search;
          const dataParam =
            new URLSearchParams(qs).get('data') ?? '';
          let appId = '';
          try {
            const dataObj = JSON.parse(dataParam);
            appId = String(dataObj.appId ?? '');
          } catch {
            /* ignore */
          }
          let body = '';
          try {
            body = await resp.text();
          } catch {
            /* ignore */
          }
          const offerHitCount = (body.match(/"offerId/g) ?? []).length;
          log(
            `[mtop] ${m[0]} appId=${appId} bodyLen=${body.length} offerId×${offerHitCount}`,
          );
          if (offerHitCount > 5) {
            try {
              const fs = await import('node:fs/promises');
              const seq = (++MTOP_SEQ).toString().padStart(2, '0');
              const file = debugTmpPath(`1688-mtop-${seq}-${appId || 'unknown'}.json`);
              await fs.writeFile(file, body);
              log(`[mtop] saved → ${file}`);
            } catch {
              /* ignore */
            }
          }
          return;
        }
        // Broaden: ANY response after this point gets logged as [other].
        // 1688 may put search results in a non-mtop endpoint.
        const len = resp.headers()['content-length'] ?? '?';
        log(
          `[other] ${new URL(u).host}${path.slice(0, 60)} ct=${ct.slice(0, 30)} len=${len}`,
        );
        if (/json/i.test(ct) || /h5api|api\.|\.json|\/api\//i.test(path)) {
          // Already logged as [other]; skip the [xhr] line.
          return;
        }
        if (
          /offer_search\.htm|sou\/index\.htm/i.test(u) &&
          /text\/html/i.test(ct)
        ) {
          const body = await resp.text();
          // Save each response to a separate file so we don't overwrite
          // earlier ones (the actual results page may be one of several).
          try {
            const fs = await import('node:fs/promises');
            const seq = (++HTML_SEQ).toString().padStart(2, '0');
            const tag = /punish/.test(u)
              ? 'punish'
              : /\.html\b/.test(u)
              ? 'html'
              : 'htm';
            const tmpPath = debugTmpPath(`1688-search-page-${seq}-${tag}.html`);
            await fs.writeFile(tmpPath, body);
            const offerHrefCount = (
              body.match(/detail\.[m.]*1688\.com\/offer\//g) ?? []
            ).length;
            log(
              `[html] saved → ${tmpPath} (${body.length} bytes, offerHref×${offerHrefCount})`,
            );
          } catch {
            /* ignore */
          }
          // Probe key patterns and print context where they appear.
          const probes = [
            'offerId":',
            '"offerId"',
            'data-offer-id',
            'data-offerid',
            '__INITIAL_STATE__',
            '__SSR_DATA__',
            'window.runParams',
            'window.cuPgcCache',
            'window.pageData',
            'window.context',
            'aliPangu',
            'i18nMtopApi',
            '"title":"',
            '"price":',
            'fullPathPrice',
            'priceRange',
          ];
          for (const p of probes) {
            const idx = body.indexOf(p);
            if (idx >= 0) {
              const ctx = body.slice(Math.max(0, idx - 20), idx + 80);
              log(
                `[hit ] "${p}" @${idx}  ...${ctx.replace(/\s+/g, ' ')}...`,
              );
            }
          }
          // Count interesting things.
          const offerIdCount = (body.match(/offerId/g) ?? []).length;
          const scriptCount = (body.match(/<script/g) ?? []).length;
          const dataIdCount = (body.match(/data-offer/gi) ?? []).length;
          log(
            `[stat] offerId×${offerIdCount} script×${scriptCount} data-offer×${dataIdCount}`,
          );
        }
      } catch {
        /* swallow */
      }
    });
  }

  const isSearchBlocked = () =>
    !headed &&
    (/\/punish|x5secdata=/.test(page.url()) || isLoginRedirectUrl(page.url()));

  // Stable strategy: always warm up on the main 1688 homepage before search.
  // Cookie-presence checks can't tell whether the WAF has invalidated the
  // session, so we pay a small constant overhead instead of betting on stale
  // cookies.
  info('Warming up www.1688.com...');
  await warmup(1500);

  const allOffers: Offer[] = [];
  const seenIds = new Set<string>();

  class PageAdvanceStopped extends Error {}

  const capturePageAction = async (
    action: () => Promise<void>,
    timeoutMs: number,
  ) => {
    const capture = startSearchOfferCapture({
      page,
      requireMethod: 'getOfferList',
      ...(sortType ? { requireSortType: sortType } : {}),
      targetPage: () => currentTargetPage,
    });
    try {
      await action();
      if (headed && await isBlocked(page, 1)) {
        const passed = await waitPastBlocking(page, true);
        if (!passed) {
          return await capture.wait({
            timeoutMs: 1,
            isClosed: () => page.isClosed(),
            isBlocked: isSearchBlocked,
          });
        }
      }
      return await capture.wait({
        timeoutMs: headed ? Math.min(timeoutMs, 15000) : timeoutMs,
        isClosed: () => page.isClosed(),
        isBlocked: isSearchBlocked,
      });
    } finally {
      capture.dispose();
    }
  };

  for (let pageNum = 1; pageNum <= pagesWanted; pageNum++) {
    currentTargetPage = pageNum;

    let captureResult;
    if (pageNum === 1) {
      captureResult = await capturePageAction(async () => {
        info(`Searching 1688 for "${keyword}"...`);
        if (headed) {
          info('A Chrome window has opened — switch focus to it now.');
        }
        if (sortType) {
          await searchThenSortOrNavigate();
        } else {
          await searchFromHomepageOrNavigate();
        }
      }, headed ? 180000 : 12000);
    } else {
      try {
        captureResult = await capturePageAction(async () => {
          // Pages 2+ MUST stay in the same page session. Every fresh navigation
          // mints a new search-context `pageId`, and `beginPage=N` against a
          // fresh pageId returns near-duplicate top results (~75% overlap).
          // Clicking the in-page "next" arrow advances `beginPage` within the
          // SAME pageId, which is the only way to get a clean next 60.
          info(`Fetching page ${pageNum}/${pagesWanted}...`);
          const advanced = await clickSearchNextPage(page).catch(() => false);
          if (!advanced) {
            info(`Could not advance to page ${pageNum} — stopping at ${allOffers.length} results.`);
            throw new PageAdvanceStopped();
          }
        }, headed ? 180000 : 12000);
      } catch (e) {
        if (e instanceof PageAdvanceStopped) break;
        throw e;
      }
    }

    let capturedOffers = captureResult.offers;
    let got = captureResult.status === 'captured';
    if (captureResult.status === 'browser_closed') {
      throw new CliError(130, 'CANCELED', 'Browser closed.');
    }
    if (!got && pageNum === 1) await detectLoginRedirect(page);
    // Retry only on page 1 — first-contact WAF warmup. A page-2+ failure
    // just stops the loop with whatever has been collected so far.
    if (!got && !headed && pageNum === 1) {
      info('First attempt blocked or empty. Re-warming and retrying...');
      await warmup(3500);
      captureResult = await capturePageAction(
        async () => {
          await navigateTo(baseUrl);
        },
        15000,
      );
      capturedOffers = captureResult.offers;
      got = captureResult.status === 'captured';
      if (captureResult.status === 'browser_closed') {
        throw new CliError(130, 'CANCELED', 'Browser closed.');
      }
      if (!got) await detectLoginRedirect(page);
    }
    if (!got) {
      if (pageNum === 1) {
        throw await searchRefusedError(page, headed);
      }
      info(
        `Page ${pageNum} blocked or empty — returning ${allOffers.length} ` +
          `results from ${pageNum - 1} page(s).`,
      );
      break;
    }
    if (pageNum === 1) await detectLoginRedirect(page);

    // Accumulate with cross-page dedup. 1688 occasionally repeats P4P ad
    // slots across pages; dedup keeps the result set clean.
    let added = 0;
    for (const o of capturedOffers) {
      if (seenIds.has(o.offerId)) continue;
      seenIds.add(o.offerId);
      allOffers.push(o);
      added++;
    }

    // Stop conditions:
    //  - collected enough for the caller's --max
    //  - short page (< 60) means we hit the last page of results
    //  - zero new items means pagination isn't advancing (bail rather than
    //    spin through identical pages)
    if (allOffers.length >= maxResults) break;
    if (capturedOffers.length < PAGE_SIZE) break;
    if (added === 0) break;

    // Human-like jitter between page clicks to keep the WAF score low.
    if (pageNum < pagesWanted) {
      await sleep(1500 + Math.random() * 2000);
    }
  }

  return allOffers;
}

export function buildSearchUrl(keyword: string, sort: SearchSort): string {
  // s.1688.com is GBK-encoded — UTF-8 percent-encoding makes the server
  // search for mojibake. Encode the keyword as GBK bytes first.
  const gbkQs = encodeGbkPercent(keyword);
  const sortType = remoteSortType(sort);
  const sortQs = sortType ? `&sortType=${encodeURIComponent(sortType)}` : '';
  return `https://s.1688.com/selloffer/offer_search.htm?keywords=${gbkQs}${sortQs}`;
}

export function shouldUseMainSiteSearchSubmit(sort: SearchSort): boolean {
  // Homepage search does not preserve remote sortType flags. Keep sorted search
  // modes on the direct URL path so public behavior stays stable.
  return sort === 'relevance';
}

const HOMEPAGE_SEARCH_INPUT_SELECTORS = [
  'input[name="keywords"]',
  'input[name="keyword"]',
  'input[type="search"]',
  'input[placeholder*="搜索"]',
  'input[placeholder*="找"]',
  'input[type="text"]',
] as const;

const HOMEPAGE_SEARCH_BUTTON_SELECTORS = [
  'button:has-text("搜索")',
  'a:has-text("搜索")',
  'input[type="submit"]',
  'button[type="submit"]',
  '.search-button',
  '.search-btn',
] as const;

const SEARCH_SORT_TEXT: Record<Exclude<SearchSort, 'relevance'>, string[]> = {
  'best-selling': ['成交额', '成交', '销量'],
  'price-asc': ['价格'],
  'price-desc': ['价格'],
};

async function trySubmitSearchFromHomepage(
  page: Page,
  keyword: string,
): Promise<boolean> {
  const input = await findFirstUsableLocator(
    page,
    HOMEPAGE_SEARCH_INPUT_SELECTORS,
    2500,
  );
  if (!input) return false;

  const beforeUrl = page.url();
  try {
    await input.click({ timeout: 2000 });
    const selectAll = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
    await page.keyboard.press(selectAll).catch(() => {});
    await page.keyboard.type(keyword, { delay: 50 + Math.random() * 40 });

    await page.keyboard.press('Enter').catch(() => {});
    if (await waitForLikelySearchNavigation(page, beforeUrl, 2500)) {
      return true;
    }

    const button = await findFirstUsableLocator(
      page,
      HOMEPAGE_SEARCH_BUTTON_SELECTORS,
      1500,
    );
    if (!button) return false;
    await button.click({ timeout: 2000 });
    return await waitForLikelySearchNavigation(page, beforeUrl, 2500);
  } catch {
    return false;
  }
}

async function tryClickSearchSort(page: Page, sort: SearchSort): Promise<boolean> {
  if (sort === 'relevance') return true;

  const labels = SEARCH_SORT_TEXT[sort];
  const clicks = sort === 'price-desc' ? 2 : 1;
  try {
    for (let i = 0; i < clicks; i++) {
      const sortControl = await findFirstUsableTextLocator(page, labels, 2500);
      if (!sortControl) return false;
      await sortControl.click({ timeout: 2000 });
      await sleep(500 + Math.random() * 300);
    }
    return true;
  } catch {
    return false;
  }
}

async function findFirstUsableLocator(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      const probeTimeout = locatorProbeTimeout(deadline);
      if (probeTimeout <= 0) return null;
      const visible = await locator
        .isVisible({ timeout: probeTimeout })
        .catch(() => false);
      if (!visible) continue;
      const enabled = await locator
        .isEnabled({ timeout: locatorProbeTimeout(deadline) })
        .catch(() => false);
      if (visible && enabled) return locator;
    }
    await sleep(150);
  }
  return null;
}

async function findFirstUsableTextLocator(
  page: Page,
  labels: readonly string[],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const label of labels) {
      const locator = page.getByText(label, { exact: false }).first();
      const probeTimeout = locatorProbeTimeout(deadline);
      if (probeTimeout <= 0) return null;
      const visible = await locator
        .isVisible({ timeout: probeTimeout })
        .catch(() => false);
      if (!visible) continue;
      const enabled = await locator
        .isEnabled({ timeout: locatorProbeTimeout(deadline) })
        .catch(() => false);
      if (visible && enabled) return locator;
    }
    await sleep(150);
  }
  return null;
}

function locatorProbeTimeout(deadline: number): number {
  return Math.max(0, Math.min(300, deadline - Date.now()));
}

async function waitForLikelySearchNavigation(
  page: Page,
  beforeUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = page.url();
    if (current !== beforeUrl && /s\.1688\.com|offer_search|keywords=/.test(current)) {
      return true;
    }
    await sleep(150);
  }
  return false;
}

function remoteSortType(sort: SearchSort): string | null {
  if (sort === 'best-selling') return 'va_rmdarkgmv30';
  if (sort === 'price-asc') return 'va_price_asc';
  if (sort === 'price-desc') return 'va_price_desc';
  return null;
}

async function isBlocked(page: Page, retries = 3): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      // URL-based detection is reliable. Body-text matching produced false
      // positives on the search results page (product names / footer / ads
      // can contain "滑动" or "验证" substrings).
      if (/\/punish|x5secdata=|punish\.1688\.com/.test(page.url())) {
        return true;
      }
      // Only fall back to title check if URL isn't conclusive. Title is
      // small enough that matching it is safe.
      const title = await page.evaluate(() => document.title ?? '');
      if (/验证码拦截|风险|滑块验证|滑动验证/.test(title)) return true;
    } catch {
      return false;
    }
    if (i < retries - 1) await sleep(800);
  }
  return false;
}

/**
 * Returns true once the page is past any risk-control gate.
 *
 * Detection strategy — be liberal: 1688 reshuffles result-card class names
 * periodically, so we don't bind to specific selectors. We poll for two
 * resilient signals instead:
 *   (1) the page URL is NOT on a punish / verification host
 *   (2) the page has a lot of anchor tags (>= 30) — punish / slider pages
 *       have a few; loaded result pages have dozens to hundreds.
 *
 * Headless: 8s budget. Headed: 3min so the user has time to solve the slider.
 */
async function waitPastBlocking(
  page: Page,
  headed: boolean,
): Promise<boolean> {
  if (await isBlocked(page, 1)) {
    if (!headed) return false;
    info('Verification page detected — drag the slider in the window.');
  }

  let lastProgressAt = Date.now();
  let lastDebugAt = 0;
  const debug = process.env.BB1688_DEBUG === '1';
  return waitWithDeadline<boolean>(async ({ now, remainingMs }) => {
    if (page.isClosed()) {
      throw new CliError(130, 'CANCELED', 'Browser closed.');
    }

    const state = await page
      .evaluate(() => ({
        url: location.href,
        title: document.title ?? '',
        anchorCount: document.querySelectorAll('a').length,
        bodyLen: (document.body?.innerText ?? '').length,
      }))
      .catch(() => null);

    if (debug && state && now - lastDebugAt > 1000) {
      info(
        `[poll] url=${state.url.slice(0, 80)} title="${state.title.slice(0, 40)}" anchors=${state.anchorCount} bodyLen=${state.bodyLen}`,
      );
      lastDebugAt = now;
    }

    if (state) {
      const onPunish = /\/punish|x5secdata=|punish\.1688\.com/.test(state.url);
      // Lowered thresholds — first paint may have fewer anchors/text than
      // the fully-hydrated SPA. 10 anchors + 500 chars beats 1688's loading
      // skeleton (a handful of nav anchors + boilerplate).
      if (
        !onPunish &&
        state.anchorCount >= 15 &&
        state.bodyLen >= 800
      ) {
        return true;
      }
    }

    if (headed && now - lastProgressAt > 10000) {
      info(
        `Still waiting for results page (${Math.round(remainingMs / 1000)}s left)...`,
      );
      lastProgressAt = now;
    }

    return null;
  }, {
    timeoutMs: headed ? 180000 : 8000,
    intervalMs: 500,
    onTimeout: () => false,
  });
}

/**
 * Page 1 ended without a results call. Say what the page actually is before blaming a slider:
 * a challenge page (solve it), a rate-limit notice, or — the case that used to be reported as
 * "slider not solved" although nothing was ever shown — a bounce back to the homepage, which is
 * 1688 throttling this session's search endpoint. Same exit code (4, RISK_CONTROL): the caller
 * still must not retry blindly; only the advice differs.
 */
async function searchRefusedError(page: Page, triedHeaded: boolean): Promise<CliError> {
  const state = await detectPageState(page).catch(() => null);
  if (!state || state.kind === 'risk_challenge') return riskControlError(triedHeaded);
  if (state.kind === 'rate_limited') {
    return new CliError(
      4,
      'RISK_CONTROL',
      `1688 rate-limited the search page (${state.url}). Wait a while and retry; image search and offer pages are unaffected.`,
    );
  }
  return new CliError(
    4,
    'RISK_CONTROL',
    `1688 refused the search: no results arrived and the page ended on ${state.url} (${state.kind}); no slider was shown. ` +
      'The search endpoint is throttling this session — reload the daemon (`1688 daemon reload --profile default`) and retry later; ' +
      'image search and offer pages are unaffected.',
  );
}

function riskControlError(triedHeaded: boolean): CliError {
  const msg = triedHeaded
    ? 'Slider verification not solved in time. Try again:\n' +
      '  1688 search "<keyword>" --headed'
    : 'Aliyun risk control triggered (slider verification). ' +
      'Run once with --headed to solve it manually; subsequent headless calls work for hours:\n' +
      '  1688 search "<keyword>" --headed';
  return new CliError(4, 'RISK_CONTROL', msg);
}

async function detectLoginRedirect(page: Page): Promise<void> {
  if (isLoginRedirectUrl(page.url())) {
    throw new CliError(
      3,
      'NOT_LOGGED_IN',
      'Session expired. Run `1688 login`.',
    );
  }
}

function isLoginRedirectUrl(url: string): boolean {
  return /login\.1688\.com|login\.taobao\.com/.test(url);
}

export async function extractOffers(page: Page): Promise<Offer[]> {
  return page.evaluate(() => {
    // Selector list for offer-detail anchors. URL patterns are far more
    // stable than DOM class names.
    const ANCHOR_SEL =
      'a[href*="detail.1688.com/offer/"], a[href*="detail.m.1688.com"], a[href*="m.1688.com/offer"]';

    function getOfferId(href: string): string | null {
      const m =
        href.match(/[?&]offerId=(\d+)/) ?? href.match(/\/offer\/(\d+)\.html/);
      return m ? m[1] ?? null : null;
    }

    function findCardForAnchor(a: HTMLAnchorElement): HTMLElement {
      // Walk up until the parent contains MORE THAN ONE distinct offerId —
      // that means we've crossed into the card list container and the
      // current `card` is the correct per-card boundary.
      let card: HTMLElement = a;
      for (let depth = 0; depth < 15; depth++) {
        const parent = card.parentElement;
        if (!parent || parent === document.body) break;
        const otherAnchors = parent.querySelectorAll<HTMLAnchorElement>(
          ANCHOR_SEL,
        );
        const ids = new Set<string>();
        for (const oa of Array.from(otherAnchors)) {
          const id = getOfferId(oa.href);
          if (id) ids.add(id);
        }
        if (ids.size > 1) return card; // over-walking — keep previous card
        card = parent;
      }
      return card;
    }

    function extractTitle(
      card: HTMLElement,
      anchor: HTMLAnchorElement,
    ): string {
      const aTitle = anchor.getAttribute('title');
      if (aTitle && aTitle.length >= 4 && aTitle.length <= 200) {
        return aTitle.trim();
      }
      const imgInA = anchor.querySelector<HTMLImageElement>('img');
      const altA = imgInA?.getAttribute('alt');
      if (altA && altA.length >= 4 && altA.length <= 200) return altA.trim();

      // Look for the most-title-like element inside the card.
      const candidates = card.querySelectorAll<HTMLElement>(
        '[class*="title" i], [class*="Title"], [class*="name" i], h1, h2, h3, h4',
      );
      for (const el of Array.from(candidates)) {
        const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (t.length >= 6 && t.length <= 200 && !/^[¥￥\d]/.test(t)) {
          return t;
        }
      }
      // Last resort: any <img> alt anywhere in the card.
      const altAny = card.querySelector('img')?.getAttribute('alt');
      if (altAny && altAny.length >= 4) return altAny.trim().slice(0, 200);
      // Give up: return empty rather than the giant card-text blob.
      return '';
    }

    function extractPrice(card: HTMLElement): {
      text: string;
      min: number | null;
      max: number | null;
    } {
      // Look for leaf elements whose ENTIRE text is a price — avoids the
      // problem of innerText concatenating "¥0.01" with "1000000~4999999 起订量"
      // into a single regex-bait string.
      const leaves = Array.from(card.querySelectorAll<HTMLElement>('*')).filter(
        (el) => el.children.length === 0,
      );
      for (const el of leaves) {
        const raw = (el.textContent ?? '').replace(/\s+/g, '');
        const m = raw.match(/^[¥￥]?([\d.]+)(?:[~\-–]([\d.]+))?$/);
        if (!m) continue;
        const min = parseFloat(m[1]!);
        if (!Number.isFinite(min) || min <= 0 || min > 1e5) continue;
        const max = m[2] ? parseFloat(m[2]) : min;
        if (max !== null && (max > 1e5 || max < min)) continue;
        return {
          text: `¥${m[1]}${m[2] ? `~${m[2]}` : ''}`,
          min,
          max,
        };
      }
      return { text: '', min: null, max: null };
    }

    function extractSupplier(card: HTMLElement): {
      name: string | null;
      shopUrl: string | null;
      years: number | null;
    } {
      // 1688 supplier shops use subdomains like shop4c1183j536987.1688.com,
      // winportXXXX.1688.com, or qm.1688.com/winport/...
      const links = Array.from(
        card.querySelectorAll<HTMLAnchorElement>('a[href*="1688.com"]'),
      ).filter((a) => {
        const h = a.href ?? '';
        if (/detail\.1688\.com|detail\.m\.1688\.com|m\.1688\.com\/offer/.test(h))
          return false;
        return /shop\w*\.1688\.com|winport|1688\.com\/page\/c/.test(h);
      });
      const link = links[0] ?? null;
      const name = link?.textContent?.trim().slice(0, 80) ?? null;
      const shopUrl = link?.href ?? null;
      const text = card.textContent ?? '';
      const ym = text.match(/(\d{1,2})\s*年/);
      const years = ym ? parseInt(ym[1]!, 10) : null;
      return { name, shopUrl, years };
    }

    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(ANCHOR_SEL),
    );
    const seen = new Set<string>();
    const out: Offer[] = [];

    for (const a of anchors) {
      const offerId = getOfferId(a.href ?? '');
      if (!offerId || seen.has(offerId)) continue;
      seen.add(offerId);

      const card = findCardForAnchor(a);
      const title = extractTitle(card, a);
      const price = extractPrice(card);
      const supplier = extractSupplier(card);
      const img =
        a.querySelector<HTMLImageElement>('img') ??
        card.querySelector<HTMLImageElement>('img');
      const image =
        img?.getAttribute('src') ?? img?.getAttribute('data-src') ?? null;

      out.push({
        offerId,
        title,
        price,
        supplier,
        location: { province: null, city: null },
        bizType: null,
        verified: { factory: false, business: false, superFactory: false },
        tags: [],
        isP4P: false,
        turnover: null,
        url: `https://detail.m.1688.com/page/index.html?offerId=${offerId}`,
        image,
      });
    }

    return out;
  });
}

// ---------- deeppro ----------

interface DeepProCollectOpts {
  headed?: boolean;
  profile?: string;
  delayMin: number;
  delayMax: number;
  maxRetries: number;
}

async function deepProCollect(
  ids: string[],
  opts: DeepProCollectOpts,
): Promise<DeepProSummary> {
  const offers: OfferResult[] = [];
  const failures: DeepProFailure[] = [];

  process.stderr.write(
    `\nDEEPPRO: starting deep collection of ${ids.length} offers (retries up to ${opts.maxRetries}x)\n`,
  );

  for (let i = 0; i < ids.length; i++) {
    const offerId = ids[i]!;
    process.stderr.write(
      `==== [${i + 1}/${ids.length}] DEEPPRO collecting offerId: ${offerId} ====\n`,
    );

    let collected: OfferResult | null = null;
    let lastCode = '';
    let lastMessage = '';
    let attempts = 0;

    for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
      attempts = attempt;
      try {
        const detail = await dispatch<OfferArgs, OfferResult>(
          'offer',
          { offerId, headed: opts.headed },
          { headed: opts.headed, profile: opts.profile, noDaemon: true },
        );

        if (!isValidDeepOffer(detail)) {
          lastCode = 'INVALID_DEEP_OFFER';
          lastMessage = 'Deep offer result is incomplete or captcha-intercepted.';
          if (attempt < opts.maxRetries) {
            process.stderr.write(
              `DEEPPRO attempt ${attempt} failed: ${offerId}, code=${lastCode}\n`,
            );
            await sleep(5000);
            continue;
          }
          break;
        }

        collected = detail;
        break;
      } catch (error) {
        const err = error as Error & { code?: string };
        lastCode = err.code || 'DEEP_COLLECT_FAILED';
        lastMessage = sanitiseDeepproMessage(err.message || String(error));
        if (attempt < opts.maxRetries) {
          process.stderr.write(
            `DEEPPRO attempt ${attempt} failed: ${offerId}, code=${lastCode}\n`,
          );
          await sleep(5000);
        }
      }
    }

    if (collected) {
      offers.push(collected);
      process.stderr.write(
        `DEEPPRO valid: ${offerId}, SKU=${collected.skus.length}, images=${collected.images.length}\n`,
      );
    } else {
      failures.push({
        offerId,
        code: lastCode || 'DEEP_COLLECT_FAILED',
        message: lastMessage || 'Unknown error after retries',
        attempts,
      });
      process.stderr.write(
        `DEEPPRO failed: ${offerId}, code=${lastCode}, attempts=${attempts}\n`,
      );
    }

    if (i < ids.length - 1) {
      const delay = randomInt(opts.delayMin * 1000, opts.delayMax * 1000);
      process.stderr.write(`waiting ${Math.round(delay / 1000)}s before next...\n`);
      await sleep(delay);
    }
  }

  process.stderr.write(
    `\nDEEPPRO complete: ${offers.length}/${ids.length} valid` +
      (failures.length > 0 ? `, ${failures.length} failed` : '') +
      '\n',
  );

  return {
    enabled: true as const,
    total: ids.length,
    success: offers.length,
    failed: failures.length,
    offerIds: ids,
    offers,
    failures,
  };
}

function isValidDeepOffer(o: OfferResult): boolean {
  if (o.title === 'Captcha Interception') return false;
  if (/captcha|验证码|滑块|风控|访问受限/i.test(o.title)) return false;
  if (o.priceRange === null && o.priceMin === null && o.priceMax === null) return false;
  if (!Array.isArray(o.images) || o.images.length === 0) return false;
  return true;
}

function sanitiseDeepproMessage(message: string): string {
  if (/x5secdata|punish|captcha|verify|nocaptcha/i.test(message)) {
    return '1688 触发滑块验证，请使用 --headed 手动处理。';
  }
  return message.length > 300 ? message.slice(0, 300) : message;
}

function randomInt(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

// ---------- output ----------

function printOffers(result: SearchResult): void {
  const { offers, keyword } = result;

  // Search results header.
  if (offers.length === 0) {
    process.stdout.write(`No offers found for "${keyword}".\n`);
  } else {
    const suffix =
      result.sort !== 'relevance' || hasActiveFilters(result.filters)
        ? ` (${offers.length}/${result.totalBeforeFilter}, sort=${result.sort})`
        : '';
    process.stdout.write(`Search results for "${keyword}"${suffix}:\n\n`);
    const w = String(offers.length).length;
    offers.forEach((o, i) => {
      const idx = String(i + 1).padStart(w, ' ');
      const price = o.price.text || '(n/a)';
      process.stdout.write(`${idx}. ${o.title}\n`);
      const pad = ' '.repeat(w + 2);
      process.stdout.write(`${pad}${price}`);
      if (o.turnover) process.stdout.write(`  ·  ${o.turnover}`);
      process.stdout.write('\n');
      const supBits = [
        o.supplier.name,
        o.supplier.years ? `${o.supplier.years}年` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      if (supBits) process.stdout.write(`${pad}${supBits}\n`);
      process.stdout.write(`${pad}${o.url}\n`);
      if (i < offers.length - 1) process.stdout.write('\n');
    });
  }

  // DEEPPRO summary.
  const dp = result.deeppro;
  if (dp) {
    process.stdout.write(
      `\nDEEPPRO: ${dp.success}/${dp.total} valid` +
        (dp.failed ? `, ${dp.failed} failed` : '') +
        '\n',
    );
    if (dp.failures.length > 0) {
      for (const f of dp.failures) {
        process.stdout.write(
          `  FAIL ${f.offerId}  ${f.code}  ${f.message.slice(0, 120)}\n`,
        );
      }
    }
  }
}
