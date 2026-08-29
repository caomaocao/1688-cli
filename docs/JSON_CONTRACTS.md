# JSON Contracts

The CLI auto-switches to JSON when stdout is piped. Stable JSON output is part
of the agent contract. Prefer additive changes; do not rename or remove fields
without an explicit breaking-change decision.

## Output Rules

- `--json` forces JSON in a TTY.
- `--pretty` indents JSON by two spaces.
- `--get <path>` prints one dot-path. Scalars are raw lines; objects and arrays
  remain JSON.
- `--pick <paths>` emits a JSON object with each requested path as a key.
- Watch commands emit line-delimited JSON, one object per new event/message.

## `whoami`

```ts
{ loggedIn: true, memberId: string, nick: string, lastVerifiedAt: string }
{ loggedIn: false }
```

## `daemon status`

`daemon status` is profile-scoped. When `--profile` is omitted, `profile` is
`default`.

```ts
{
  profile: string,
  running: boolean,
  pid?: number,
  reachable?: boolean,
  version?: string | null,
  expectedVersion?: string,
  versionMatches?: boolean,
  stats?: {
    profile: string,
    version: string,
    startedAt: string,
    pid: number,
    commandCount: number,
    lastRequestAt: string | null,
    lastError: string | null,
    uptimeMs: number,
    activeClients: number,
    browser: {
      profile: string | null,
      browserAlive: boolean,
      pageCount: number,
      currentUrl: string | null,
      pageState: object | null,
      loggedIn: boolean | null,
    },
    health: object,
  },
}
```

## `profile status`

```ts
{
  profile: {
    name: string,
    path: string,
    exists: boolean,
    locked: boolean,
    loggedIn: boolean,
    recentRequestId: string | null,
    recentStatus: string | null,
    recentErrorCode: string | null,
    daemon: {
      profile: string,
      running: boolean,
      pid?: number,
      reachable?: boolean,
      version?: string | null,
      expectedVersion?: string,
      versionMatches?: boolean,
    },
  },
  state: {
    version: 1,
    memberId?: string,
    nick?: string,
    loggedInAt?: string,
    lastVerifiedAt?: string,
  } | null,
}
```

## `doctor`

`doctor --profile <name>` checks that profile's directory, lock, state,
daemon, and live daemon socket. JSON output includes the selected `profile` and
the matching profile-scoped daemon status.

```ts
{
  ok: boolean,
  profile: string,
  checks: Array<{ name: string, status: "ok" | "warn" | "fail", message: string, fix?: string }>,
  version: VersionInfo,
  daemon: DaemonStatus | null,
}
```

## `search`, `similar`, `image-search`

```ts
{
  keyword?: string,
  imageId?: string,
  offerId?: string,
  sort?: "relevance" | "best-selling" | "price-asc" | "price-desc",
  filters?: object,
  totalBeforeFilter?: number,
  total: number,
  offers: Array<{
    offerId: string,
    title: string,
    price: { text: string, min: number | null, max: number | null },
    supplier: { name: string | null, shopUrl: string | null, years: number | null },
    location: { province: string | null, city: string | null },
    bizType: string | null,
    verified: { factory: boolean, business: boolean, superFactory: boolean },
    tags: string[],
    serviceTags?: string[],
    productBadges?: string[],
    demand?: {
      orderCountText: string | null,
      orderCount: number | null,
      repurchaseRateText: string | null,
      repurchaseRate: number | null,
    },
    isP4P: boolean,
    turnover: string | null,
    url: string,
    image: string | null,
  }>
}
```

`image-search --engine plugin` keeps `imageId`, `total` and the `offers[]`
shape above (mapped from the extension's offer items; `isP4P` is always
`false` there because that feed carries no ad flag) and adds:

```ts
{
  engine: "plugin",
  region: string | null,        // box 1688 used, native "x1,x2,y1,y2" (pixels of the uploaded file)
  yoloCropRegion: string[],     // 1688's candidate subject boxes, same format
  pagesFetched: number,         // 40 offers per page; total = server totalCount
  offers: Array<Offer & {
    plugin: {
      stats: {
        saleQuantity: number | null, bookedCount: number | null,
        payOrderCount30d: number | null, payItemCount30d: number | null,
        quantitySumMonth: number | null, buyerCount: number | null,
        sales90: number | null, sales360: number | null, gmv: number | null,
        repurchaseRate: number | null,   // offer-level, percent
        inquiryUv: number | null, evaluateCount: number | null,
      },
      shop: {
        memberId: string | null, loginId: string | null, url: string | null,
        creditLevel: number | null, creditLevelText: string | null,
        regCapital: string | null,       // e.g. "100万"
        shopRepurchaseRate: number | null, // percent
        tpYear: number | null, isFactory: boolean, goldSupplier: boolean,
        compositeScore: number | null, goodsScore: number | null,
        logisticsScore: number | null, consultationScore: number | null,
        disputeScore: number | null,
      },
      price: {
        price: number | null, consignPrice: number | null, priceUnderLine: number | null,
        priceType: string | null, quantityBegin: number | null, unit: string | null,
      },
      images: string[],                  // up to 5 extra offer images
      freight: { free: boolean | null, cost: number | null },
      categoryId: string | null,
      brand: string | null,
      attributes: Record<string, string>,
      service: {
        sevenDaysReturn: boolean, sevenDaysRefund: boolean, freightInsurance: boolean,
        mixWholesale: boolean, deliveryHours: number | null,
      },
      sameDesignCount: number | null,
      saleStats: object | null,          // server saleStatsModel passthrough
      shopInfo: object | null,           // server shopInfoModel passthrough
      raw?: { item: object, extend: object | null },  // only with --raw
    },
  }>,
}
```

`search --deeppro` keeps the normal `search` fields and adds:

```ts
{
  deeppro: {
    enabled: true,
    total: number,
    success: number,
    failed: number,
    offerIds: string[],
    offers: OfferResult[],
    failures: Array<{
      offerId: string,
      code: string,
      message: string,
      attempts: number,
    }>,
  },
}
```

`similar` uses this shape only when 1688's official same-product endpoint
returns comparable offers. The command intentionally does not fall back to
keyword or image search. When the official endpoint returns the current empty
image-search shell, JSON error output uses:

```ts
{
  ok: false,
  code: "SIMILAR_UNAVAILABLE",
  message: string,
  details: {
    offerId: string,
    source: "official-similar-page",
    category: "similar_unavailable",
    failureKind: "similar_unavailable",
    recoveryAction: "none",
    retryable: false,
    recoverHint: string,
    artifactDir?: string,
    currentUrl?: string,
  }
}
```

## `research`

Normal JSON result:

```ts
{
  queries: string[],
  sort: "relevance" | "best-selling" | "price-asc" | "price-desc",
  filters: object,
  maxPerQuery: number,
  enrichTop: number,
  total: number,
  enrichedCount: number,
  items: Array<{
    sourceKeyword: string,
    sourceRank: number,
    globalRank: number,
    offer: Offer,
    demand: {
      turnoverText: string | null,
      orderCount: number | null,
      repurchaseRate: number | null,
    },
    supplier: {
      years: number | null,
      verified: Offer["verified"],
      tags: string[],
      isAd: boolean,
    },
    score: number,
    scoreBreakdown: Array<{ name: string, points: number, reason: string }>,
    enriched?: OfferDetailSummary,
    error?: { code: string, message: string },
  }>,
}
```

`--jsonl` emits one research item per line. `--csv` emits a CSV table.

## `compare`

```ts
{
  total: number,
  ok: number,
  failed: number,
  items: Array<{
    offerId: string,
    ok: boolean,
    score: number | null,
    scoreBreakdown: Array<{ name: string, points: number, reason: string }>,
    summary: OfferDetailSummary | null,
    error?: { code: string, message: string },
  }>,
}
```

## `supplier inspect`

```ts
{
  target: {
    input: string,
    type: "offerId" | "memberId",
    offerId: string | null,
    memberId: string | null,
  },
  supplier: {
    name: string | null,
    loginId: string | null,
    memberId: string | null,
    userId: string | null,
    companyId: string | null,
    shopUrl: string | null,
    shopUrls: Record<string, string>,
    identity: string | null,
    signs: Record<string, boolean>,
  },
  factory: {
    isFactory: boolean,
    superFactory: boolean,
    tpYears: number | null,
    medalLevel: string | null,
    thirdPartyAuthProvider: string | null,
    establishedAtText: string | null,
    location: string | null,
    address: string | null,
    coordinates: { latitude: number | null, longitude: number | null },
    productionService: string | null,
    employeeScale: string | null,
    workerCount: string | null,
    profile: string | null,
    tags: string[],
  },
  trust: {
    companyLabel: string | null,
    retentionRate: number | null,
    companyIcons: Array<{ title: string, link: string | null }>,
    shopTags: string[],
    serviceScores: Array<{ key: string, label: string, score: number | null }>,
  },
  offers: { availableCount: number | null, source: "factory-card-dom" | null },
  sources: {
    offerUrl: string | null,
    factoryCardUrl: string | null,
    shopcardCaptured: boolean,
    factoryCardCaptured: boolean,
  },
  warnings: string[],
}
```

V1 supports offerId, offer URL, `b2b-*` memberId, and factory-card URL.
loginId-only input is rejected because live probing showed it can resolve to
the wrong supplier.

## `supplier search`, `supplier research`

Supplier discovery uses 1688 company search
(`companySearchBusinessService`). It must not be treated as offer-search
supplier aggregation.

```ts
{
  queries: string[],
  source: {
    kind: "company-search",
    endpoint: "companySearchBusinessService",
    offerAggregation: false,
  },
  filters: {
    factoryOnly: boolean,
    province: string | null,
    city: string | null,
    minYears: number | null,
    minRepeatRate: number | null,
    minResponseRate: number | null,
  },
  maxPerQuery: number,
  enrichTop: number,
  totalBeforeFilter: number,
  total: number,
  enrichedCount: number,
  items: Array<{
    sourceKeyword: string,
    sourceRank: number,
    globalRank: number,
    supplier: {
      companyName: string,
      loginId: string | null,
      memberId: string | null,
      enterpriseId: string | null,
      realUserId: string | null,
      companyId: string | null,
      shopUrl: string | null,
      factoryCardUrl: string | null,
      domainUri: string | null,
      location: {
        province: string | null,
        city: string | null,
        address: string | null,
        latitude: number | null,
        longitude: number | null,
      },
      productionService: string | null,
      businessMode: string | null,
      tp: {
        memberLevel: string | null,
        serviceYears: number | null,
        tpNum: number | null,
      },
      factory: {
        isFactory: boolean,
        factoryTag: string | null,
        factoryLevel: string | null,
        shiliFactory: boolean,
        shiliCompany: boolean,
        superFactory: boolean,
        businessInspection: boolean,
        factoryInspection: boolean,
        qiJianCompany: boolean,
        safePurchase: boolean,
        trust: boolean,
      },
      service: {
        compositeScore: number | null,
        wwResponseRate: number | null,
        repeatRate: number | null,
        complianceRate: number | null,
      },
      demand: {
        payOrderCount3m: number | null,
        payAmount3m: number | null,
        fuzzyPayAmount3m: string | null,
        saleQuantity3m: number | null,
        memberBookedCount: number | null,
      },
      tags: string[],
      offersPreview: Array<{
        offerId: string | null,
        title: string,
        url: string | null,
        price: { text: string | null, value: number | null },
        unit: string | null,
        image: string | null,
        bookedCount: number | null,
        saleQuantity: number | null,
        quantitySumMonth: number | null,
        brief: string | null,
      }>,
    },
    score: number,
    scoreBreakdown: Array<{ name: string, points: number, reason: string }>,
    inspect?: SupplierInspectResult,
    error?: { code: string, message: string },
  }>,
}
```

`supplier search` defaults to `--enrich 0`; `supplier research` defaults to
`--enrich top:10`. `--jsonl` emits one supplier item per line. `--csv` emits a
CSV table.

## `offer`

```ts
{
  offerId: string,
  title: string,
  url: string,
  priceRange: string | null,
  priceMin: number | null,
  priceMax: number | null,
  unitName: string | null,
  minOrderQty: number | null,
  mixOrderQty: number | null,
  priceTiers: Array<{ minQty: number, price: number }>,
  detailUrl: string | null,
  attributes: Array<{ name: string, value: string }>,
  packageInfo: Array<{
    skuId: string,
    spec: string,
    length: number | null,
    width: number | null,
    height: number | null,
    weight: number | null,
    volume: number | null,
  }>,
  supplier: {
    name: string | null,
    loginId: string | null,
    memberId: string | null,
    userId: string | null,
  },
  freight: {
    receiveAddress: string | null,
    sendArea: string | null,
    province: string | null,
    city: string | null,
    unitWeight: number | null,
  },
  saledCount: number | null,
  categoryId: string | null,
  options: Array<{ prop: string, values: Array<{ name: string, imageUrl: string | null }> }>,
  skus: Array<{
    skuId: string,
    specs: string,
    price: number | null,
    multiPrice: number | null,
    stock: number | null,
    saleCount: number,
    image: string | null,
  }>,
  mainImage: string | null,
  images: string[],
}
```

When `offer` receives multiple IDs, it emits a batch envelope instead of the
single-offer shape:

```ts
{
  mode: "batch",
  total: number,
  success: number,
  failed: number,
  offerIds: string[],
  offers: OfferResult[],
  failures: Array<{
    offerId: string,
    code: string,
    message: string,
  }>,
}
```

## `seller messages`

One-shot result:

```ts
{
  conversation: string,
  total: number,
  messages: Array<{
    sender: string,
    time: string | null,
    isMine: boolean,
    content: string,
    read: boolean,
    kind: "text" | "offerCard" | "orderCard" | "autoReply"
        | "assessment" | "image" | "other",
    card?: {
      title: string | null,
      price: string | null,
      image: string | null,
      url: string | null,
    },
    messageId?: string,
  }>,
}
```

Watch mode emits one object per new message:

```ts
{ conversation: string, message: Message }
```

## `cart add`

```ts
{
  ok: boolean,
  added: CartItem,
  isNewRow: boolean,
  addedQuantity: number,
}
```

## `order list`

Orders include buyer actions, service entries, and display badges. Preserve
`actions[]`, `services[]`, and `badges[]` because downstream agents use them to
decide what follow-up is possible.

## Generated Shape Index

Run `pnpm agent-context` to refresh `docs/generated/json-shapes.md`, which
indexes exported TypeScript interfaces from command modules.
