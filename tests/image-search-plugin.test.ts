import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliError } from '../src/io/errors.js';
import {
  mapPluginPage,
  mtopFailure,
  pageTransport,
  runPluginSearch,
  shouldDiscardHostPage,
  type MtopTransport,
} from '../src/commands/image-search-plugin.js';
import type { Page } from 'playwright';
import { parseEngine } from '../src/commands/image-search.js';
import {
  PLUGIN_APP_ID,
  PLUGIN_PAGE_SIZE,
  PLUGIN_SEARCH_API,
  PLUGIN_SEARCH_SCENE,
  PLUGIN_SEARCH_VERSION,
  PLUGIN_UPLOAD_API,
  PLUGIN_UPLOAD_VERSION,
  buildSearchRequest,
  buildUploadRequest,
  classifyMtopRet,
  mtopRetCode,
  parseSearchResponse,
  parseUploadResponse,
  splitYoloRegions,
  type MtopEnvelope,
  type MtopRequestSpec,
} from '../src/session/plugin-image-search.js';

const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'plugin-image-search',
  'search-response.json',
);
const IMAGE_ID = '1249708826795507246';

let searchEnvelope: MtopEnvelope;
let imagePath: string;
let tmpDir: string;

beforeAll(async () => {
  searchEnvelope = JSON.parse(await fs.readFile(FIXTURE, 'utf8')) as MtopEnvelope;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-plugin-'));
  imagePath = path.join(tmpDir, 'crop.jpg');
  await fs.writeFile(imagePath, Buffer.from('not-really-a-jpeg'));
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

// A fake transport that records every request and answers from a queue.
function fakeTransport(answers: MtopEnvelope[]): {
  transport: MtopTransport;
  calls: MtopRequestSpec[];
} {
  const calls: MtopRequestSpec[] = [];
  const queue = [...answers];
  const transport: MtopTransport = async (spec) => {
    calls.push(spec);
    const next = queue.shift();
    if (!next) throw new Error('fake transport: no answer queued');
    return next;
  };
  return { transport, calls };
}

describe('request builders', () => {
  it('builds the upload request exactly like the extension', () => {
    const spec = buildUploadRequest('QUJD');
    expect(spec).toMatchObject({
      api: PLUGIN_UPLOAD_API,
      v: PLUGIN_UPLOAD_VERSION,
      type: 'POST',
    });
    expect(spec.data.appId).toBe(PLUGIN_APP_ID);
    expect(paramsOf(spec)).toEqual({
      searchScene: 'imageEx',
      interfaceName: 'imageBase64ToImageId',
      'serviceParam.extendParam[subChannel]': 'pc_image_plugin_image_id',
      'serviceParam.extendParam[imageBase64]': 'QUJD',
    });
  });

  it('builds the search request with the extension field set and no region key when absent', () => {
    const spec = buildSearchRequest({ imageId: IMAGE_ID, beginPage: 1 });
    expect(spec).toMatchObject({
      api: PLUGIN_SEARCH_API,
      v: PLUGIN_SEARCH_VERSION,
      type: 'GET',
    });
    expect(spec.data.scene).toBe(PLUGIN_SEARCH_SCENE);
    const params = paramsOf(spec);
    expect(Object.keys(params)).toEqual([
      'searchScene',
      'serviceGroupName',
      'interfaceName',
      'serviceParam.extendParam[subChannel]',
      'serviceParam.extendParam[imageId]',
      'serviceParam.extendParam[appName]',
      'abRequest.level3Biz',
      'abRequest.level2Biz',
      'abRequest.level1Biz',
      'serviceParam.extendParam[pageSize]',
      'serviceParam.extendParam[beginPage]',
    ]);
    expect(params).toMatchObject({
      searchScene: 'imageEx',
      serviceGroupName: 'service.group.pc.image',
      interfaceName: 'imageExtraSearchService',
      'serviceParam.extendParam[subChannel]': 'pc_image_plugin',
      'serviceParam.extendParam[imageId]': IMAGE_ID,
      'serviceParam.extendParam[appName]': 'imageExtra',
      'abRequest.level3Biz': 'main',
      'abRequest.level2Biz': 'image',
      'abRequest.level1Biz': 'search',
      'serviceParam.extendParam[pageSize]': PLUGIN_PAGE_SIZE,
      'serviceParam.extendParam[beginPage]': 1,
    });
    expect(PLUGIN_PAGE_SIZE).toBe(40);
  });
});

describe('response parsing', () => {
  it('reads the JSON-string inner payload', () => {
    const page = parseSearchResponse(searchEnvelope.data);
    expect(page.total).toBe(697);
    expect(page.offerSize).toBe(40);
    expect(page.region).toBe('31,262,33,284');
    expect(page.offers.map((o) => String(o.id))).toEqual([
      '974335991949',
      '577700197733',
      '748780325502',
    ]);
    expect(Object.keys(page.offerExtend)).toEqual([
      '974335991949',
      '577700197733',
      '748780325502',
    ]);
  });

  it('splits yoloCropRegion on ";" and tolerates absence', () => {
    expect(splitYoloRegions('1,2,3,4;5,6,7,8')).toEqual(['1,2,3,4', '5,6,7,8']);
    expect(splitYoloRegions(undefined)).toEqual([]);
    expect(splitYoloRegions('')).toEqual([]);
  });

  it('handles an empty or malformed inner payload without throwing', () => {
    expect(parseSearchResponse({})).toMatchObject({ offers: [], total: 0, region: null });
    expect(
      parseSearchResponse({ responseInfo: { imageSearchOfferResultViewService: '{oops' } }),
    ).toMatchObject({ offers: [], total: 0 });
  });

  it('reads the imageId from an upload response', () => {
    expect(parseUploadResponse({ imageId: IMAGE_ID })).toBe(IMAGE_ID);
    expect(parseUploadResponse({ imageId: 42 })).toBe('42');
    expect(parseUploadResponse({})).toBeNull();
  });
});

describe('offer mapping', () => {
  it('maps a plugin item onto Offer plus a normalised plugin block', () => {
    const [first] = mapPluginPage(parseSearchResponse(searchEnvelope.data));
    expect(first).toBeDefined();
    expect(first!.offerId).toBe('974335991949');
    expect(first!.title).toBe('工厂现货7CM13个灯珠RF遥控四磁铁带吸盘LED泳池潜水灯庭院装防水');
    expect(first!.price).toEqual({ text: '¥14.82', min: 14.82, max: 14.82 });
    expect(first!.supplier).toEqual({
      name: '深圳市祥宇光电子科技有限公司',
      shopUrl: 'http://shop45240464wb185.1688.com',
      years: 1,
    });
    expect(first!.location).toEqual({ province: '广东', city: '惠州市惠阳区' });
    expect(first!.bizType).toBe('生产加工');
    expect(first!.verified).toEqual({ factory: false, business: false, superFactory: false });
    expect(first!.demand).toEqual({
      orderCountText: '458',
      orderCount: 458,
      repurchaseRateText: '46.4%',
      repurchaseRate: 46.4,
    });
    expect(first!.isP4P).toBe(false);
    expect(first!.url).toBe('https://detail.1688.com/offer/974335991949.html');
    expect(first!.image).toMatch(/^https:\/\/cbu01\.alicdn\.com\//);
    expect(first!.tags).toEqual(['先采后付']);

    const p = first!.plugin;
    expect(p.stats).toMatchObject({
      saleQuantity: 933,
      bookedCount: 458,
      payOrderCount30d: 72,
      payItemCount30d: 124,
      quantitySumMonth: 110,
      buyerCount: 0,
      sales90: 585,
      sales360: 931,
      gmv: 4000,
      repurchaseRate: 45.45,
      inquiryUv: 20,
      evaluateCount: 0,
    });
    expect(p.shop).toMatchObject({
      memberId: 'b2b-2220709198980f13b2',
      loginId: '深圳祥宇光电子',
      creditLevel: 3,
      creditLevelText: 'A',
      regCapital: '100万',
      shopRepurchaseRate: 46.4,
      tpYear: 1,
      isFactory: false,
      goldSupplier: false,
      compositeScore: 4.5,
      goodsScore: 5,
      logisticsScore: 4.14,
      consultationScore: 0,
      disputeScore: 5,
    });
    expect(p.price).toEqual({
      price: 14.82,
      consignPrice: 15.6,
      priceUnderLine: 15.6,
      priceType: 'MMEMBER',
      quantityBegin: 1,
      unit: '只',
    });
    expect(p.images).toHaveLength(5);
    expect(p.freight).toEqual({ free: false, cost: 10 });
    expect(p.categoryId).toBe('1032292');
    expect(p.brand).toBe('翔宇');
    expect(p.attributes).toEqual({ 品牌: '翔宇', 规格: '一个灯配一个遥控', 防护等级: 'IP67' });
    expect(p.service).toEqual({
      sevenDaysReturn: false,
      sevenDaysRefund: false,
      freightInsurance: false,
      mixWholesale: false,
      deliveryHours: 48,
    });
    expect(p.sameDesignCount).toBeNull();
    expect(p.saleStats).toMatchObject({ totalSales: '700+' });
    expect(p.shopInfo).toMatchObject({ tpYear: 1 });
    expect(p.raw).toBeUndefined();
  });

  it('skips items without a numeric id and survives an empty list', () => {
    const page = parseSearchResponse(searchEnvelope.data);
    page.offers = [{ ...page.offers[0], id: undefined }, ...page.offers.slice(1)];
    expect(mapPluginPage(page).map((o) => o.offerId)).toEqual([
      '577700197733',
      '748780325502',
    ]);
    expect(mapPluginPage({ ...page, offers: [] })).toEqual([]);
  });
});

describe('runPluginSearch', () => {
  it('uploads then searches once for the default page and shapes the result', async () => {
    const { transport, calls } = fakeTransport([uploadOk(), searchEnvelope]);
    const result = await runPluginSearch(transport, { imagePath, max: 40 });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.api).toBe(PLUGIN_UPLOAD_API);
    expect(paramsOf(calls[0]!)['serviceParam.extendParam[imageBase64]']).toBe(
      Buffer.from('not-really-a-jpeg').toString('base64'),
    );
    expect(calls[1]!.api).toBe(PLUGIN_SEARCH_API);
    expect(paramsOf(calls[1]!)['serviceParam.extendParam[imageId]']).toBe(IMAGE_ID);
    expect(paramsOf(calls[1]!)['serviceParam.extendParam[beginPage]']).toBe(1);
    expect(paramsOf(calls[1]!)).not.toHaveProperty('serviceParam.extendParam[region]');

    expect(result).toMatchObject({
      engine: 'plugin',
      imageId: IMAGE_ID,
      total: 697,
      region: '31,262,33,284',
      pagesFetched: 1,
    });
    expect(result.yoloCropRegion).toEqual(['31,262,33,284']);
    expect(result.offers.map((o) => o.offerId)).toEqual([
      '974335991949',
      '577700197733',
      '748780325502',
    ]);
  });

  it('returns no offers and total 0 for an empty offerList', async () => {
    const empty: MtopEnvelope = {
      ret: ['SUCCESS::调用成功'],
      data: {
        responseInfo: {
          imageSearchOfferResultViewService: JSON.stringify({ data: { offerList: [] } }),
        },
      },
    };
    const { transport } = fakeTransport([uploadOk(), empty]);
    const result = await runPluginSearch(transport, { imagePath, max: 40 });
    expect(result.offers).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.pagesFetched).toBe(1);
  });

  it('fails with UPSTREAM_ERROR carrying the ret code and stops at the first failure', async () => {
    const { transport, calls } = fakeTransport([
      { ret: ['1006::系统开小差了，请稍候重试'] },
      searchEnvelope,
    ]);
    const err = await runPluginSearch(transport, { imagePath, max: 40 }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('UPSTREAM_ERROR');
    expect((err as CliError).details.ret).toBe('1006::系统开小差了，请稍候重试');
    expect(calls).toHaveLength(1);
  });

  it('fails with UPSTREAM_ERROR on a search-stage failure', async () => {
    const { transport, calls } = fakeTransport([
      uploadOk(),
      { ret: ['FAIL_SYS_TRAFFIC_LIMIT::限流'] },
    ]);
    const err = await runPluginSearch(transport, { imagePath, max: 40 }).catch((e) => e);
    expect((err as CliError).code).toBe('UPSTREAM_ERROR');
    expect((err as CliError).details.stage).toBe('search');
    expect(calls).toHaveLength(2);
  });

  it('rejects an unreadable image before any transport call', async () => {
    const { transport, calls } = fakeTransport([]);
    const err = await runPluginSearch(transport, {
      imagePath: path.join(tmpDir, 'missing.jpg'),
      max: 40,
    }).catch((e) => e);
    expect((err as CliError).code).toBe('BAD_INPUT');
    expect(calls).toHaveLength(0);
  });
});

describe('engine option', () => {
  it('defaults to page and accepts plugin', () => {
    expect(parseEngine(undefined)).toBe('page');
    expect(parseEngine('page')).toBe('page');
    expect(parseEngine('plugin')).toBe('plugin');
    expect(parseEngine(' Plugin ')).toBe('plugin');
  });

  it('rejects unknown engines', () => {
    expect(() => parseEngine('browser')).toThrowError(/Unknown --engine/);
  });
});

describe('mtop timeout (2026-08-29 daemon hang)', () => {
  const spec = { api: 'mtop.x', v: '1.0', type: 'POST', data: {} } as unknown as MtopRequestSpec;

  it('pageTransport gives up when the in-page evaluate never returns', async () => {
    const page = { evaluate: () => new Promise<never>(() => {}) } as unknown as Page;
    const env = await pageTransport(page, 10, 20)(spec);
    expect(mtopRetCode(env)).toMatch(/^MTOP_TIMEOUT::page\.evaluate/);
    expect(classifyMtopRet(mtopRetCode(env))).toBe('timeout');
  });

  it('pageTransport passes the timeout into the page and returns a normal envelope otherwise', async () => {
    let seen: unknown;
    const page = {
      evaluate: (_fn: unknown, arg: unknown) => {
        seen = arg;
        return Promise.resolve({ ret: ['SUCCESS::ok'], data: { x: 1 } });
      },
    } as unknown as Page;
    const env = await pageTransport(page, 1234, 5)(spec);
    expect((seen as { timeoutMs: number }).timeoutMs).toBe(1234);
    expect(classifyMtopRet(mtopRetCode(env))).toBe('ok');
  });

  it('a timeout is its own CLI error and discards the cached host page', () => {
    const e = mtopFailure('MTOP_TIMEOUT::no mtop callback within 60000ms', 'upload');
    expect(e.code).toBe('MTOP_TIMEOUT');
    expect(e.exitCode).toBe(9);
    expect(shouldDiscardHostPage(e.code)).toBe(true);
    expect(shouldDiscardHostPage('UPSTREAM_ERROR')).toBe(false);
  });
});
