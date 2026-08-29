// mtop-level helpers for `image-search --engine plugin`: the request shapes
// used by the official "1688官方采购助手" Chrome extension's 找同款 drawer,
// response parsing into raw server shapes, region handling and `ret`
// classification. Everything here is side-effect free and command-agnostic;
// the JSON-facing offer mapping lives with the command
// (`commands/image-search-plugin.ts`) per ARCHITECTURE.md.
//
// Request facts (from the extension's kapp bundle,
// g.alicdn.com/innovateHub/extension-offer-search/0.0.73/js/203.js):
//   - upload: mtop.relationrecommend.WirelessRecommend.recommend v2.0 (POST),
//     appId 32517, interfaceName imageBase64ToImageId -> data.imageId
//   - search: mtop.1688.pc.plugin.imageSearch.plugin.search. The extension
//     sends v1.1 with an AES "metaInfo" token; extensions older than 0.1.34
//     fall back to v1.0 without the token (`downgradeVersion: "1.0"`), which
//     is the path used here. Only imageId / region / beginPage vary per call;
//     every other field is sent exactly as the extension sends it.
//   - response: data.responseInfo.imageSearchOfferResultViewService is a JSON
//     string -> { data: { offerList, offerSize, totalCount, region,
//     yoloCropRegion } }; data.offerExtend[id] carries extra per-offer info.

export const PLUGIN_APP_ID = '32517';
export const PLUGIN_UPLOAD_API = 'mtop.relationrecommend.WirelessRecommend.recommend';
export const PLUGIN_UPLOAD_VERSION = '2.0';
export const PLUGIN_SEARCH_API = 'mtop.1688.pc.plugin.imageSearch.plugin.search';
export const PLUGIN_SEARCH_VERSION = '1.0';
export const PLUGIN_SEARCH_SCENE = 'IMAGE_SEARCH_DRAWER';
// Fixed on purpose: the extension always requests 40 per page. `--max` only
// controls how many pages we fetch and where we truncate.
export const PLUGIN_PAGE_SIZE = 40;
export const PLUGIN_MAX_RESULTS = 200;
export const PLUGIN_DEFAULT_MAX = 40;
// Hard cap on the base64 payload we are willing to send (decision: no
// client-side resizing, so coordinates stay 1:1 with the original image).
export const PLUGIN_MAX_BASE64_BYTES = 4 * 1024 * 1024;

// The page whose `window.lib.mtop` signs our requests. This is the extension's
// own kapp, i.e. the real consumer of these APIs.
export const PLUGIN_HOST_PAGE_URL =
  'https://air.1688.com/kapp/innovateHub/extension-offer-search/imageSearch';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface MtopRequestSpec {
  api: string;
  v: string;
  type: 'GET' | 'POST';
  data: Record<string, unknown>;
}

export function buildUploadRequest(imageBase64: string): MtopRequestSpec {
  return {
    api: PLUGIN_UPLOAD_API,
    v: PLUGIN_UPLOAD_VERSION,
    type: 'POST',
    data: {
      appId: PLUGIN_APP_ID,
      params: JSON.stringify({
        searchScene: 'imageEx',
        interfaceName: 'imageBase64ToImageId',
        'serviceParam.extendParam[subChannel]': 'pc_image_plugin_image_id',
        'serviceParam.extendParam[imageBase64]': imageBase64,
      }),
    },
  };
}

export interface SearchRequestInput {
  imageId: string;
  beginPage: number;
  region?: string | null;
}

export function buildSearchRequest(input: SearchRequestInput): MtopRequestSpec {
  // Key order and value set mirror the extension; `region` is omitted (not
  // sent as null) when absent, matching JSON.stringify of `undefined`.
  const params: Record<string, unknown> = {
    searchScene: 'imageEx',
    serviceGroupName: 'service.group.pc.image',
    interfaceName: 'imageExtraSearchService',
    'serviceParam.extendParam[subChannel]': 'pc_image_plugin',
    'serviceParam.extendParam[imageId]': input.imageId,
  };
  if (input.region) params['serviceParam.extendParam[region]'] = input.region;
  Object.assign(params, {
    'serviceParam.extendParam[appName]': 'imageExtra',
    'abRequest.level3Biz': 'main',
    'abRequest.level2Biz': 'image',
    'abRequest.level1Biz': 'search',
    'serviceParam.extendParam[pageSize]': PLUGIN_PAGE_SIZE,
    'serviceParam.extendParam[beginPage]': input.beginPage,
  });
  return {
    api: PLUGIN_SEARCH_API,
    v: PLUGIN_SEARCH_VERSION,
    type: 'GET',
    data: { params: JSON.stringify(params), scene: PLUGIN_SEARCH_SCENE },
  };
}

// Base64 length of a file of `bytes` bytes (4 chars per 3 bytes, padded).
export function base64LengthOf(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

// ---------------------------------------------------------------------------
// Region
// ---------------------------------------------------------------------------

// 1688's native region format is "x1,x2,y1,y2" (both x first, then both y),
// in pixels of the uploaded image. Kept verbatim on input and output.
const REGION_RE = /^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/;

export function normalizeRegion(raw: string): string | null {
  const m = raw.match(REGION_RE);
  if (!m) return null;
  const [x1, x2, y1, y2] = [m[1], m[2], m[3], m[4]].map((s) => Number(s));
  if (x1 === undefined || x2 === undefined || y1 === undefined || y2 === undefined) {
    return null;
  }
  if (x2 <= x1 || y2 <= y1) return null;
  return `${x1},${x2},${y1},${y2}`;
}

export function splitYoloRegions(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// mtop result classification
// ---------------------------------------------------------------------------

export interface MtopEnvelope {
  ret?: unknown;
  data?: unknown;
  api?: string;
  v?: string;
}

export type MtopFailureKind = 'ok' | 'risk_control' | 'not_logged_in' | 'upstream' | 'timeout';

// Synthetic `ret` produced by the transport when lib.mtop never calls back (the
// request is neither answered nor failed). Seen 2026-08-29: three uploads of one
// kit-photo cover hung the daemon's serial queue for good.
export const MTOP_TIMEOUT_RET = 'MTOP_TIMEOUT';

export function mtopTimeoutEnvelope(reason: string): MtopEnvelope {
  return { ret: [`${MTOP_TIMEOUT_RET}::${reason}`] };
}

export function mtopRetCode(env: MtopEnvelope | null | undefined): string {
  const ret = env?.ret;
  if (Array.isArray(ret) && typeof ret[0] === 'string') return ret[0];
  if (typeof ret === 'string') return ret;
  return '';
}

export function classifyMtopRet(ret: string): MtopFailureKind {
  if (/^SUCCESS/i.test(ret)) return 'ok';
  if (ret.startsWith(MTOP_TIMEOUT_RET)) return 'timeout';
  if (/RGV587_ERROR|FAIL_SYS_USER_VALIDATE|punish|滑块|安全验证/i.test(ret)) {
    return 'risk_control';
  }
  if (/FAIL_SYS_SESSION_EXPIRED|FAIL_SYS_ILLEGAL_ACCESS|FAIL_SYS_TOKEN_(?:EMPTY|ILLEGAL)|NOT_LOGIN/i.test(ret)) {
    return 'not_logged_in';
  }
  return 'upstream';
}

// Risk-control envelopes usually carry the verification page in `data.url`.
export function mtopChallengeUrl(env: MtopEnvelope | null | undefined): string | null {
  const data = env?.data as { url?: unknown } | null | undefined;
  return typeof data?.url === 'string' && /^https?:\/\//.test(data.url) ? data.url : null;
}

// ---------------------------------------------------------------------------
// Response parsing (raw server shapes)
// ---------------------------------------------------------------------------

export interface PluginRawOfferItem {
  id?: number | string;
  information?: {
    subject?: string;
    simpleSubject?: string;
    detailUrl?: string;
    categoryId?: number | string;
    evaluateCount?: number;
    createDays?: number;
    byrInquiryUv?: number;
    rePurchaseRate?: string;
    fieldExtensionMap?: Record<string, unknown>;
    propertyValueModel?: {
      propertyValuePairs?: Array<{ pValue?: string; vValue?: string }>;
    };
  };
  company?: {
    name?: string;
    hoverName?: string;
    url?: string;
    memberId?: string;
    province?: string;
    city?: string;
    bizTypeName?: string;
    isFactory?: string;
    isSuperFactory?: boolean;
    creditLevel?: number;
    creditLevelText?: string;
    regCapital?: number;
    regCapitalUnit?: string;
    shopRepurchaseRate?: string;
    shopRepurchaseRateLevel?: string;
  };
  tradePrice?: {
    offerPrice?: {
      valueString?: string;
      priceInfo?: {
        price?: string;
        consignPrice?: string;
        priceUnderLine?: string;
        priceType?: string;
      };
      quantityPrices?: unknown[];
    };
    freightPrice?: { enable?: boolean; free?: boolean };
  };
  tradeQuantity?: {
    saleQuantity?: number;
    bookedCount?: number;
    number?: number;
    quantityBegin?: number;
    unit?: string;
    sellUnit?: string;
    payOrderCount30d?: string | number;
    payItemCount30d?: string | number;
    quantitySumMonth?: number;
    buyerCount?: number;
    vaSales90?: string | number;
    vaSales360?: string | number;
    gmvValue?: { integer?: number; decimals?: number };
    gmv30dRt?: number;
  };
  tradeService?: {
    tpYear?: number;
    tpMember?: boolean;
    factoryInspection?: boolean;
    businessInspection?: boolean;
    goldSupplier?: boolean;
    compositeScore?: number | string;
    compositeNewScore?: number | string;
    goodsScore?: number | string;
    logisticsScore?: number | string;
    consultationScore?: number | string;
    disputeScore?: number | string;
    returnScore?: number | string;
    deliveryHours?: number;
    sevenDaysReturn?: boolean;
    sevenDaysRefund?: boolean;
    freightInsurance?: boolean;
    mixWholesale?: boolean;
    onlineTrade?: boolean;
  };
  image?: { imgUrl?: string; imgUrlOf270x270?: string };
  brand?: { name?: string; enable?: boolean };
  sameAndSimilarDesign?: {
    sameDesign?: { enable?: boolean; count?: number };
    similarDesign?: { enable?: boolean };
  };
  commonPositionLabels?: Record<string, Array<{ text?: string }>>;
  aliTalk?: { loginId?: string };
}

export interface PluginOfferExtend {
  images?: string[];
  shopInfoModel?: Record<string, unknown>;
  saleStatsModel?: Record<string, unknown>;
  deliveryChargeInfo?: {
    costs?: Array<{ totalCost?: number; subTemplateName?: string }>;
  };
}

export interface PluginSearchPage {
  offers: PluginRawOfferItem[];
  offerExtend: Record<string, PluginOfferExtend>;
  offerSize: number;
  total: number;
  region: string | null;
  yoloCropRegion: string[];
  requestId: string | null;
}

interface SearchResponseData {
  requestId?: string;
  offerExtend?: Record<string, PluginOfferExtend>;
  responseInfo?: { imageSearchOfferResultViewService?: string };
}

export function parseSearchResponse(data: unknown): PluginSearchPage {
  const d = (data ?? {}) as SearchResponseData;
  const inner = d.responseInfo?.imageSearchOfferResultViewService;
  let view: {
    data?: {
      offerList?: PluginRawOfferItem[];
      offerSize?: number;
      totalCount?: number;
      region?: string;
      yoloCropRegion?: string;
    };
  } = {};
  if (typeof inner === 'string' && inner.trim()) {
    try {
      view = JSON.parse(inner) as typeof view;
    } catch {
      view = {};
    }
  }
  const body = view.data ?? {};
  return {
    offers: Array.isArray(body.offerList) ? body.offerList : [],
    offerExtend: d.offerExtend ?? {},
    offerSize: Number(body.offerSize ?? 0) || 0,
    total: Number(body.totalCount ?? 0) || 0,
    region: typeof body.region === 'string' && body.region ? body.region : null,
    yoloCropRegion: splitYoloRegions(body.yoloCropRegion),
    requestId: typeof d.requestId === 'string' ? d.requestId : null,
  };
}

export function parseUploadResponse(data: unknown): string | null {
  const d = data as { imageId?: unknown } | null | undefined;
  const id = d?.imageId;
  if (typeof id === 'string' && /^\d+$/.test(id)) return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return null;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

export function pagesFor(max: number): number {
  return Math.max(1, Math.ceil(max / PLUGIN_PAGE_SIZE));
}
