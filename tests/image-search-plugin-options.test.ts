import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliError } from '../src/io/errors.js';
import { parsePluginOptions, pluginSummaryLine } from '../src/commands/image-search.js';
import {
  PLUGIN_PACE_JITTER_MS,
  PLUGIN_PACE_MIN_MS,
  discardHostPage,
  execute,
  getHostPage,
  markPluginCallEnded,
  mtopFailure,
  nextPluginCallDelay,
  runPluginSearch,
  type MtopTransport,
} from '../src/commands/image-search-plugin.js';
import {
  PLUGIN_PAGE_SIZE,
  classifyMtopRet,
  normalizeRegion,
  type MtopEnvelope,
  type MtopRequestSpec,
} from '../src/session/plugin-image-search.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'plugin-image-search', 'search-response.json');
const IMAGE_ID = '1249708826795507246';

let fixture: MtopEnvelope;
let tmpDir: string;
let imagePath: string;

beforeAll(async () => {
  fixture = JSON.parse(await fs.readFile(FIXTURE, 'utf8')) as MtopEnvelope;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-plugin-opts-'));
  imagePath = path.join(tmpDir, 'img.jpg');
  await fs.writeFile(imagePath, Buffer.from('jpg-bytes'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function uploadOk(): MtopEnvelope {
  return { ret: ['SUCCESS::调用成功'], data: { imageId: IMAGE_ID } };
}

function paramsOf(spec: MtopRequestSpec): Record<string, unknown> {
  return JSON.parse(String(spec.data.params)) as Record<string, unknown>;
}

// A synthetic page of `n` minimal items with ids offset by `start`.
function pageOf(n: number, start: number, total = 697): MtopEnvelope {
  const offerList = Array.from({ length: n }, (_, i) => ({
    id: 1000 + start + i,
    information: { subject: `item ${start + i}` },
    tradePrice: { offerPrice: { priceInfo: { price: '1.00' } } },
  }));
  return {
    ret: ['SUCCESS::调用成功'],
    data: {
      responseInfo: {
        imageSearchOfferResultViewService: JSON.stringify({
          data: { offerList, offerSize: n, totalCount: total, region: '1,2,3,4', yoloCropRegion: '1,2,3,4' },
        }),
      },
    },
  };
}

function fakeTransport(answers: MtopEnvelope[]): { transport: MtopTransport; calls: MtopRequestSpec[] } {
  const calls: MtopRequestSpec[] = [];
  const queue = [...answers];
  return {
    calls,
    transport: async (spec) => {
      calls.push(spec);
      const next = queue.shift();
      if (!next) throw new Error('no answer queued');
      return next;
    },
  };
}

function bad(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected a CliError');
}

// ---------------------------------------------------------------------------
// Ticket 02: --region / --image-id
// ---------------------------------------------------------------------------

describe('normalizeRegion', () => {
  it('accepts x1,x2,y1,y2 with optional whitespace and keeps 1688 order', () => {
    expect(normalizeRegion('31,262,33,284')).toBe('31,262,33,284');
    expect(normalizeRegion(' 31 , 262 ,33, 284 ')).toBe('31,262,33,284');
  });

  it('rejects wrong arity, non-integers and inverted boxes', () => {
    expect(normalizeRegion('1,2,3')).toBeNull();
    expect(normalizeRegion('1,2,3,4,5')).toBeNull();
    expect(normalizeRegion('1.5,2,3,4')).toBeNull();
    expect(normalizeRegion('a,b,c,d')).toBeNull();
    expect(normalizeRegion('10,10,3,4')).toBeNull(); // x2 <= x1
    expect(normalizeRegion('1,2,40,4')).toBeNull(); // y2 <= y1
  });
});

describe('parsePluginOptions', () => {
  it('rejects plugin-only flags under the page engine', () => {
    expect(bad(() => parsePluginOptions('page', { region: '1,2,3,4' })).code).toBe('BAD_INPUT');
    expect(bad(() => parsePluginOptions('page', { imageId: '1' })).code).toBe('BAD_INPUT');
    expect(bad(() => parsePluginOptions('page', { raw: true })).code).toBe('BAD_INPUT');
    expect(bad(() => parsePluginOptions('page', { region: '1,2,3,4' })).message).toContain('--region');
  });

  it('keeps the page engine max default at 20 and allows raw:false', () => {
    expect(parsePluginOptions('page', { raw: false })).toEqual({
      region: null,
      imageId: null,
      raw: false,
      max: 20,
    });
  });

  it('normalises region and image id for the plugin engine', () => {
    expect(parsePluginOptions('plugin', { region: ' 31,262, 33,284', imageId: ' 42 ' })).toEqual({
      region: '31,262,33,284',
      imageId: '42',
      raw: false,
      max: 40,
    });
  });

  it('rejects malformed region and non-numeric image id', () => {
    expect(bad(() => parsePluginOptions('plugin', { region: '1,2,3' })).code).toBe('BAD_INPUT');
    expect(bad(() => parsePluginOptions('plugin', { region: '9,1,1,2' })).code).toBe('BAD_INPUT');
    expect(bad(() => parsePluginOptions('plugin', { imageId: 'abc' })).code).toBe('BAD_INPUT');
  });

  // Ticket 03
  it('defaults max to 40, caps at 200 and rejects junk', () => {
    expect(parsePluginOptions('plugin', {}).max).toBe(40);
    expect(parsePluginOptions('plugin', { max: '200' }).max).toBe(200);
    expect(parsePluginOptions('plugin', { max: '1' }).max).toBe(1);
    for (const max of ['201', '0', '-5', 'abc', '2.5']) {
      expect(bad(() => parsePluginOptions('plugin', { max })).code).toBe('BAD_INPUT');
    }
  });
});

describe('runPluginSearch with --region / --image-id', () => {
  it('forwards region verbatim, placed after imageId and before appName', async () => {
    const { transport, calls } = fakeTransport([uploadOk(), fixture]);
    const result = await runPluginSearch(transport, { imagePath, max: 40, region: '31,262,33,284' });
    const keys = Object.keys(paramsOf(calls[1]!));
    expect(paramsOf(calls[1]!)['serviceParam.extendParam[region]']).toBe('31,262,33,284');
    expect(keys.indexOf('serviceParam.extendParam[region]')).toBe(
      keys.indexOf('serviceParam.extendParam[imageId]') + 1,
    );
    expect(keys.indexOf('serviceParam.extendParam[appName]')).toBe(
      keys.indexOf('serviceParam.extendParam[region]') + 1,
    );
    expect(result.region).toBe('31,262,33,284');
    expect(result.yoloCropRegion.length).toBeGreaterThan(0);
  });

  it('skips the upload when imageId is given, even if a file is present', async () => {
    const { transport, calls } = fakeTransport([fixture]);
    const result = await runPluginSearch(transport, { imagePath, imageId: '777', max: 40 });
    expect(calls).toHaveLength(1);
    expect(paramsOf(calls[0]!)['serviceParam.extendParam[imageId]']).toBe('777');
    expect(result.imageId).toBe('777');
  });

  it('requires either a file or an image id', async () => {
    const { transport, calls } = fakeTransport([]);
    const err = await runPluginSearch(transport, { max: 40 }).catch((e) => e as CliError);
    expect((err as CliError).code).toBe('BAD_INPUT');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ticket 05: --raw and the human summary line
// ---------------------------------------------------------------------------

describe('--raw and human output', () => {
  it('attaches the untouched item only with raw', async () => {
    const a = fakeTransport([uploadOk(), fixture]);
    const plain = await runPluginSearch(a.transport, { imagePath, max: 40 });
    expect(plain.offers[0]!.plugin.raw).toBeUndefined();

    const b = fakeTransport([uploadOk(), fixture]);
    const raw = await runPluginSearch(b.transport, { imagePath, max: 40, raw: true });
    const r = raw.offers[0]!.plugin.raw as { item: { id: number }; extend: unknown };
    expect(r.item.id).toBe(974335991949);
    expect(r.extend).toMatchObject({ shopInfoModel: { tpYear: 1 } });
  });

  it('prints 30d orders · repurchase · shop years for plugin offers only', async () => {
    const { transport } = fakeTransport([uploadOk(), fixture]);
    const result = await runPluginSearch(transport, { imagePath, max: 40 });
    expect(pluginSummaryLine(result.offers[0]!)).toBe('30d单量 72 · 复购 46.4% · 店龄 1年');
    const { plugin: _drop, ...pageOffer } = result.offers[0]!;
    expect(pluginSummaryLine(pageOffer)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Ticket 03: pagination
// ---------------------------------------------------------------------------

describe('runPluginSearch pagination', () => {
  it('fetches two pages for max 80 with one page gap and keeps page order', async () => {
    const { transport, calls } = fakeTransport([uploadOk(), pageOf(40, 0), pageOf(40, 40)]);
    let gaps = 0;
    const result = await runPluginSearch(
      transport,
      { imagePath, max: 80 },
      { pageGap: async () => void gaps++ },
    );
    expect(calls.map((c) => paramsOf(c)['serviceParam.extendParam[beginPage]'])).toEqual([
      undefined,
      1,
      2,
    ]);
    expect(calls.slice(1).every((c) => paramsOf(c)['serviceParam.extendParam[pageSize]'] === PLUGIN_PAGE_SIZE)).toBe(true);
    expect(gaps).toBe(1);
    expect(result.pagesFetched).toBe(2);
    expect(result.offers).toHaveLength(80);
    expect(result.offers[0]!.offerId).toBe('1000');
    expect(result.offers[79]!.offerId).toBe('1079');
    expect(result.total).toBe(697);
  });

  it('truncates to max after fetching ceil(max/40) pages', async () => {
    const { transport, calls } = fakeTransport([uploadOk(), pageOf(40, 0), pageOf(40, 40)]);
    const result = await runPluginSearch(transport, { imagePath, max: 50 }, { pageGap: async () => {} });
    expect(calls).toHaveLength(3);
    expect(result.offers).toHaveLength(50);
    expect(result.pagesFetched).toBe(2);
  });

  it('fetches a single page for max 1 and returns one offer', async () => {
    const { transport, calls } = fakeTransport([uploadOk(), pageOf(40, 0)]);
    const result = await runPluginSearch(transport, { imagePath, max: 1 });
    expect(calls).toHaveLength(2);
    expect(result.offers).toHaveLength(1);
    expect(result.pagesFetched).toBe(1);
  });

  it('stops early when a page comes back short', async () => {
    const { transport, calls } = fakeTransport([uploadOk(), pageOf(12, 0, 12)]);
    let gaps = 0;
    const result = await runPluginSearch(
      transport,
      { imagePath, max: 120 },
      { pageGap: async () => void gaps++ },
    );
    expect(calls).toHaveLength(2);
    expect(gaps).toBe(0);
    expect(result.offers).toHaveLength(12);
    expect(result.pagesFetched).toBe(1);
    expect(result.total).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Ticket 04: error mapping, host page hygiene, pacing
// ---------------------------------------------------------------------------

describe('mtop ret classification and mapping', () => {
  it('classifies the ret families', () => {
    expect(classifyMtopRet('SUCCESS::调用成功')).toBe('ok');
    expect(classifyMtopRet('RGV587_ERROR::SM')).toBe('risk_control');
    expect(classifyMtopRet('FAIL_SYS_USER_VALIDATE::用户校验')).toBe('risk_control');
    expect(classifyMtopRet('FAIL_SYS_SESSION_EXPIRED::Session过期')).toBe('not_logged_in');
    expect(classifyMtopRet('FAIL_SYS_ILLEGAL_ACCESS::非法请求')).toBe('not_logged_in');
    expect(classifyMtopRet('FAIL_SYS_TOKEN_EMPTY::令牌为空')).toBe('not_logged_in');
    expect(classifyMtopRet('1006::系统开小差了，请稍候重试')).toBe('upstream');
    expect(classifyMtopRet('')).toBe('upstream');
  });

  it('maps risk control to exit 4 RISK_CONTROL with a --headed hint', () => {
    const err = mtopFailure('RGV587_ERROR::SM', 'search');
    expect(err.exitCode).toBe(4);
    expect(err.code).toBe('RISK_CONTROL');
    expect(err.details.ret).toBe('RGV587_ERROR::SM');
    expect(String(err.details.recoverHint)).toContain('--headed');
  });

  it('maps session expiry to exit 3 NOT_LOGGED_IN and others to exit 9 UPSTREAM_ERROR', () => {
    const login = mtopFailure('FAIL_SYS_SESSION_EXPIRED::x', 'upload');
    expect(login.exitCode).toBe(3);
    expect(login.code).toBe('NOT_LOGGED_IN');
    const other = mtopFailure('1006::系统开小差了，请稍候重试', 'search');
    expect(other.exitCode).toBe(9);
    expect(other.code).toBe('UPSTREAM_ERROR');
    expect(other.details.ret).toBe('1006::系统开小差了，请稍候重试');
  });

  it('does not issue further calls after a risk-control reply', async () => {
    const { transport, calls } = fakeTransport([uploadOk(), { ret: ['RGV587_ERROR::SM'] }, fixture]);
    const err = await runPluginSearch(transport, { imagePath, max: 80 }, { pageGap: async () => {} }).catch(
      (e) => e as CliError,
    );
    expect((err as CliError).code).toBe('RISK_CONTROL');
    expect(calls).toHaveLength(2);
  });
});

describe('pacing', () => {
  it('waits at least the minimum gap plus jitter since the last plugin call', () => {
    expect(nextPluginCallDelay(10_000, 0)).toBe(0);
    expect(nextPluginCallDelay(10_000, 9_000, () => 0)).toBe(PLUGIN_PACE_MIN_MS - 1000);
    expect(nextPluginCallDelay(10_000, 9_000, () => 0.999)).toBe(
      PLUGIN_PACE_MIN_MS - 1000 + Math.floor(0.999 * PLUGIN_PACE_JITTER_MS),
    );
    expect(nextPluginCallDelay(20_000, 9_000, () => 0.999)).toBe(0);
  });
});

// A fake browser context / page pair good enough for the host-page cache
// and the recovery wrapper. `evaluate` answers the mtop health probe with
// `true` (no argument) and mtop requests from a queue (with argument).
function fakeBrowser(answers: MtopEnvelope[]) {
  const queue = [...answers];
  let created = 0;
  const pages: Page[] = [];
  const makePage = (): Page => {
    created++;
    let closed = false;
    const page = {
      isClosed: () => closed,
      url: () => 'https://air.1688.com/kapp/innovateHub/extension-offer-search/imageSearch',
      title: async () => '',
      goto: async () => null,
      waitForFunction: async () => null,
      evaluate: async (_fn: unknown, arg?: unknown) => {
        if (arg === undefined) return true;
        const next = queue.shift();
        if (!next) throw new Error('no answer queued');
        return next;
      },
      close: async () => {
        closed = true;
      },
      on: () => page,
      off: () => page,
      removeListener: () => page,
    } as unknown as Page;
    pages.push(page);
    return page;
  };
  const ctx = {
    newPage: async () => makePage(),
    pages: () => pages.filter((p) => !p.isClosed()),
    on: () => ctx,
    off: () => ctx,
    removeListener: () => ctx,
  } as unknown as BrowserContext;
  return { ctx, created: () => created, pages };
}

describe('host page cache', () => {
  it('reuses a healthy page and rebuilds after discard', async () => {
    const b = fakeBrowser([]);
    const p1 = await getHostPage(b.ctx);
    const p2 = await getHostPage(b.ctx);
    expect(p2).toBe(p1);
    expect(b.created()).toBe(1);
    await discardHostPage(b.ctx);
    expect(p1.isClosed()).toBe(true);
    const p3 = await getHostPage(b.ctx);
    expect(p3).not.toBe(p1);
    expect(b.created()).toBe(2);
  });

  it('execute discards the host page after RISK_CONTROL and keeps it after success', async () => {
    const previousHome = process.env.BB1688_HOME;
    process.env.BB1688_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-home-'));
    try {
      const ok = fakeBrowser([uploadOk(), fixture]);
      await execute(ok.ctx, { imagePath, max: 40 });
      expect(ok.pages[0]!.isClosed()).toBe(false);

      // Reset the pacer so the second call does not sleep 3–6 s in the test.
      markPluginCallEnded(0);
      const risky = fakeBrowser([uploadOk(), { ret: ['RGV587_ERROR::SM'] }]);
      const err = await execute(risky.ctx, { imagePath, max: 40 }).catch((e) => e as CliError);
      expect((err as CliError).code).toBe('RISK_CONTROL');
      expect((err as CliError).exitCode).toBe(4);
      expect(risky.pages[0]!.isClosed()).toBe(true);
      expect(risky.created()).toBe(1); // no retry, no rebuild within the call
    } finally {
      if (previousHome === undefined) delete process.env.BB1688_HOME;
      else process.env.BB1688_HOME = previousHome;
    }
  }, 30_000);
});
