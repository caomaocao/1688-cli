# Spec: `image-search --engine plugin`

Status: ready-for-agent · Branch: `feat/image-search-plugin-engine` (based on v0.1.48)

## Problem Statement

`1688 image-search` finds offers that look like a photo, but a sourcing user
cannot tell it *which object* in the photo to match. 1688 picks a subject box
server-side, and on kit/lifestyle photos that box is frequently wrong (a glue
tube instead of the product), so the whole result set is garbage and the user
only discovers it after reading 20 titles. The command also stops at the first
~60 results with no way to page deeper, and each result carries only a handful
of fields, so anyone ranking candidates (sales, repurchase, shop age, credit)
must issue one `offer` call per candidate — expensive and risk-control heavy.

Meanwhile every `image-search` costs two full page loads (upload page +
results page, dozens of requests each), which is the single biggest
contributor to this session's risk-control budget.

## Solution

Add an alternative engine to the existing command:
`1688 image-search <image> --engine plugin`. It drives the same 1688 image
search backend through the two lightweight mtop calls that 1688's own
"官方采购助手" browser extension uses for 找同款, which expose three things the
page-scraping path cannot: an explicit subject box (`--region`), 40-per-page
pagination, and a rich per-offer record. The default engine (`page`) is
untouched; the new engine adds fields to the JSON output without changing any
existing field.

## User Stories

1. As a sourcing user, I want `image-search` to keep working exactly as before when I don't pass `--engine`, so that my scripts and habits are unaffected.
2. As a sourcing user, I want `--engine plugin` to accept the same local path or http(s) URL as the default engine, so that I don't need to learn a new input form.
3. As a sourcing user, I want to pass `--region x1,x2,y1,y2` so that the search matches the object I care about rather than 1688's guess.
4. As a sourcing user, I want the response to tell me which region 1688 actually used, so that I can see whether my box (or its guess) was honoured.
5. As a sourcing user, I want the response to list 1688's candidate subject boxes (`yoloCropRegion`), so that I can pick one and re-search without doing my own object detection.
6. As a sourcing user, I want `--image-id <id>` to reuse an already uploaded image, so that searching several subject boxes on one photo costs one upload and N searches instead of N uploads.
7. As a sourcing user, I want every plugin-engine response to include the `imageId`, so that I can reuse it in follow-up calls.
8. As a sourcing user, I want `--max` to fetch more than one page (40 per page) up to a sane cap, so that I can go deeper than the first screen without writing a loop.
9. As a sourcing user, I want the response to report the server-side total and how many pages were fetched, so that I know how much of the pool I have seen.
10. As a sourcing user, I want the plugin engine's `--max` to default to one full page (40), so that a bare call returns exactly what the extension shows.
11. As a sourcing user, I want each offer to keep the familiar `Offer` fields (title, price, supplier, location, verified, demand, url, image), so that consumers of the existing contract need no changes.
12. As a sourcing user, I want each offer to carry a `plugin` block with normalised sales, shop, price, service, image and attribute data, so that I can rank candidates without one `offer` call per candidate.
13. As a data engineer, I want `--raw` to attach the untouched server item to each offer, so that I can inspect fields the normalised block does not cover when designing schemas.
14. As a sourcing user, I want the human-readable output to show 30-day orders, repurchase rate and shop age when the plugin engine is used, so that I can eyeball candidates in the terminal.
15. As a sourcing user, I want plugin-only flags (`--region`, `--image-id`, `--raw`) to fail fast with `BAD_INPUT` under the default engine, so that I never silently get a different search than I asked for.
16. As a sourcing user, I want malformed `--region` values (wrong arity, non-integers, x2≤x1, y2≤y1) rejected with `BAD_INPUT` before any request is made, so that I don't burn a request on a bad box.
17. As a sourcing user, I want `--max` above the cap (200) rejected with `BAD_INPUT`, so that a typo cannot fire dozens of requests.
18. As a sourcing user, I want images whose base64 exceeds the cap (4 MB) rejected with `BAD_INPUT` and a hint to shrink them, so that coordinates stay 1:1 with my file and I know why it failed.
19. As a sourcing user, I want the plugin engine to send exactly the request the extension sends (fixed page size 40, same channel/scene/ab fields), so that my traffic is indistinguishable from a real extension user.
20. As a sourcing user, I want a risk-control response from mtop to surface as `RISK_CONTROL` with the same recovery hint as other commands, so that I know to run once with `--headed`.
21. As a sourcing user, I want a session-expired response to surface as `NOT_LOGGED_IN`, so that I know to run `1688 login`.
22. As a sourcing user, I want any other non-success mtop code to surface as `UPSTREAM_ERROR` with the original code in `details`, so that I can report or debug it.
23. As a sourcing user, I want the engine to never auto-retry after a risk-control or login failure, so that I don't dig the hole deeper.
24. As a daemon user, I want the plugin engine to keep one hidden 1688 page open across calls, so that repeated searches cost zero page loads.
25. As a daemon user, I want that hidden page checked before every call (alive, not redirected to login/punish, mtop library present) and rebuilt when broken, so that a stale page never produces confusing errors.
26. As a daemon user, I want the hidden page discarded after a risk-control or login failure, so that the next call starts from a clean page.
27. As a `--headed` user, I want the plugin engine to open a visible page so that I can solve a slider if 1688 shows one, then have the command continue.
28. As a daemon user, I want the plugin engine paced more conservatively than the page engine (3–6 s between calls, 2–4 s between pages), so that deeper pagination doesn't trip rate limits.
29. As a daemon user, I want the plugin engine to run through the daemon like the page engine (same command name, no new socket command), so that `1688 daemon status` and health pauses apply to it.
30. As a contributor, I want the request builders, response parser, offer mapper and error classifier to be pure functions, so that they can be tested against captured fixtures without a browser.
31. As a contributor, I want the executor to depend on an injected mtop transport, so that the whole flow (upload → pages → map → truncate → errors) is testable with a fake transport.
32. As a contributor, I want `docs/COMMANDS.md`, `docs/JSON_CONTRACTS.md`, `README.md` and `CHANGELOG.md` updated and `pnpm agent-verify` green, so that the agent context stays truthful.

## Implementation Decisions

- **Command surface.** No new command and no command group. `image-search` gains `--engine <page|plugin>` (default `page`), `--region <x1,x2,y1,y2>`, `--image-id <id>`, `--raw`. The three plugin-only options are rejected with `BAD_INPUT` when `--engine` is `page`. Precedent: `search --deeppro` and `offer --pro` switch implementation paths behind a flag and extend output additively.
- **Old path untouched.** The existing page-scraping executor is not modified. The command's executor branches on `engine` at its top; the plugin path lives in its own command module and its own session helper module. The daemon dispatch registry is unchanged because the command name is unchanged.
- **Transport.** All 1688 traffic for the plugin engine goes through `window.lib.mtop.request` executed inside a 1688-origin page (it owns the `_m_h5_tk` signing and token refresh). The executor receives an `MtopTransport` — a function from a request spec `{api, v, type, data}` to an mtop envelope `{ret, data}` — so browser mechanics stay outside the search logic.
- **Host page.** In daemon mode a single hidden page on the extension's own kapp (`air.1688.com/kapp/innovateHub/extension-offer-search/imageSearch`) is created lazily, cached per shared browser context, health-checked before each use (not closed, page state classified as a normal 1688 page — i.e. not login / punish — and `lib.mtop` present) and recreated on failure. `--headed` opens a fresh visible page per call and closes it afterwards; plain inline mode (daemon unreachable) uses the same cache, which dies with the per-call browser context. After a `RISK_CONTROL` or `NOT_LOGGED_IN` outcome the cached page is closed; after `UPSTREAM_ERROR` it is kept. A host page that lands on a login / punish URL fails with `NOT_LOGGED_IN` / `RISK_CONTROL` (`details.stage: "host-page"`); a host page whose `lib.mtop` never becomes ready within 20 s fails with `NETWORK_ERROR`.
- **Headed challenge flow.** With `--headed`, a risk-control reply (or a punish page on host-page load) does not fail immediately: the engine navigates the visible page to the challenge URL 1688 returned in `data.url` (or reloads the page when none is given), polls the page state until it is a normal 1688 page again (up to 3 minutes), brings the host page and `lib.mtop` back, and retries that one request exactly once. A second risk reply, or the timeout, fails with `RISK_CONTROL` and the headed message variant ("not solved in time"). Headless mode never enters this flow.
- **mtop wrapper parity.** The transport mirrors the extension's own mtop wrapper: `lib.mtop.config` prefix `h5api` / mainDomain `1688.com` / subDomain `m`, `customConfig.NeedAuthToken=false` (the token-less v1.0 path) and the `X-Accept-Language` header. These are part of "the request the extension sends", not additions.
- **Requests.** Upload: `mtop.relationrecommend.WirelessRecommend.recommend` v2.0, POST, `appId 32517`, `interfaceName imageBase64ToImageId`, sub-channel `pc_image_plugin_image_id`. Search: `mtop.1688.pc.plugin.imageSearch.plugin.search` **v1.0**, GET, `scene IMAGE_SEARCH_DRAWER`, `params` = the extension's field set (`searchScene imageEx`, `serviceGroupName service.group.pc.image`, `interfaceName imageExtraSearchService`, sub-channel `pc_image_plugin`, `appName imageExtra`, `abRequest.level1/2/3Biz = search/image/main`, `pageSize 40`). Only `imageId`, `region` (omitted when absent) and `beginPage` vary. v1.1 requires the extension's AES token and is not used; v1.0 is the extension's own documented downgrade path.
- **No resizing.** The image file is base64-encoded as-is; `--region` therefore refers to the original file's pixels. Payloads above 4 MB base64 are rejected — by the CLI before dispatch (a stat-based estimate) and again by the executor before pacing, so a doomed call never pays for a wait or a page load.
- **Positional image.** The positional image argument is optional at the commander level (it must be, for `--image-id`). A bare `1688 image-search` therefore fails with `BAD_INPUT` (exit 2) from the command instead of commander's usage error — the one accepted deviation from "exactly as before" for the page engine.
- **Region format.** Input and output use 1688's native `x1,x2,y1,y2` string (both x first). `yoloCropRegion` is split on `;` into a string array in the same format. No conversion anywhere.
- **Pagination.** `pageSize` is always 40. `--max` (plugin default 40, cap 200) determines pages = ceil(max/40); pages are fetched sequentially with a 2–4 s gap and the concatenated list is truncated to `max`. Output adds `total` (server `totalCount`) and `pagesFetched`. No `--page` option.
- **Output contract.** Top level: existing `{imageId, total, offers}` plus `engine: "plugin"`, `region` (string|null, as returned by 1688), `yoloCropRegion: string[]`, `pagesFetched`. Each offer: the full existing `Offer` shape (mapped from the plugin item) plus `plugin: {stats, shop, price, images, freight, categoryId, brand, attributes, service, sameDesignCount, saleStats, shopInfo, raw?}`; `raw` is present only with `--raw`. `isP4P` is always `false` on this engine (the plugin feed carries no ad flag).
- **Error mapping.** mtop `ret[0]` → `RISK_CONTROL` (`RGV587_ERROR*`, `FAIL_SYS_USER_VALIDATE`, punish/slider text), `NOT_LOGGED_IN` (`FAIL_SYS_SESSION_EXPIRED`, `FAIL_SYS_ILLEGAL_ACCESS`, `FAIL_SYS_TOKEN_*`, or host page redirected to login), otherwise `UPSTREAM_ERROR` with the original code in `details.ret`. `RISK_CONTROL`/`NOT_LOGGED_IN` are raised as the same `CliError` codes the existing recovery layer already classifies, so daemon health pauses and `--headed` hints apply unchanged. No automatic retry on those two.
- **Pacing.** A dedicated pacing key for the plugin engine: minimum 3 s plus 0–3 s jitter between calls, independent of the daemon's per-command throttle (which stays at its current 1.2–3 s for the page engine).
- **Human output.** The existing per-offer text block gains one extra line under the plugin engine: 30-day orders · repurchase rate · shop years, when available.
- **Docs.** `COMMANDS.md` (new flags + a paragraph on when to use which engine), `JSON_CONTRACTS.md` (additive block), `README.md` command table + example, `CHANGELOG.md` Unreleased; regenerate agent context.

## Testing Decisions

- A good test drives the executor through the `MtopTransport` seam with a fake transport and asserts on observable outputs: the request specs that were sent (api, version, params, order of calls), the JSON result (offers, truncation, `total`, `pagesFetched`, `region`, `yoloCropRegion`), and the thrown `CliError` code/details. Tests do not reach into private state; the host-page cache, the headed challenge flow and the recovery wrapper are exercised end to end through `execute()` with a fake browser context/page (url sequence, evaluate queue, close tracking).
- Fixture: a trimmed real response (three offer items plus their `offerExtend`, region and yolo string) captured from the extension's API during the 2026-08-29 research; offer data is public listing data. Upload fixture: a minimal `{ret:["SUCCESS::调用成功"], data:{imageId}}` envelope.
- Cases: default engine unchanged (no plugin options → old executor invoked, verified by a spy); plugin default `--max` 40 → one upload + one search; `--max 80` → two searches with `beginPage` 1 and 2 and a page gap; `--max 50` → two pages truncated to 50; `--image-id` → no upload call; `--region` forwarded verbatim and reflected in output; invalid region / over-cap max / plugin flags under page engine / oversize base64 → `BAD_INPUT` with no transport call; `ret` variants → `RISK_CONTROL` / `NOT_LOGGED_IN` / `UPSTREAM_ERROR`; mapping of a full item into `Offer` + `plugin` block (including `raw` only with `--raw`).
- Pure helpers (request builders, region normaliser, yolo splitter, response parser, `ret` classifier) get direct unit tests as well because they are the contract with 1688.
- Prior art: `tests/image-search.test.ts` (mock Playwright page emitting responses), `tests/fixtures/search/mtop-offers.jsonp` (captured mtop body as fixture), `tests/page-state.test.ts`.
- Live verification (manual, ≤5 requests, not in CI): same imageId + region as a captured search must reproduce the captured top-40 offer ids; a call without `--region` must return a non-empty `yoloCropRegion`; `--max 80` must return two distinct pages. Results are kept in the consuming project (`tiktok_sales/data/sourcing_1688/_plugin/cli_engine_check/`), not in this repo: 38/40 overlap, yolo returned, 80 unique offers over two pages, no risk control (2026-08-29).

## Out of Scope

- Keyword search through the extension's `textSearch.cbu.search` (token-locked; no downgrade path).
- Fixing `1688 similar`.
- Client-side image resizing or any coordinate conversion.
- A `--subject <n>` convenience (caller does default search → pick a yolo box → re-search with `--image-id` + `--region`).
- A `--page` option or per-page output.
- Changes to the daemon protocol, throttle module or recovery classifier.
- Contributing the feature upstream (decide after using it for a while).
- Changes in the consuming project (`tiktok_sales` scripts adopting the engine, ranking on the new fields) — separate round.

## Further Notes

- Risk control is per account/cookie and shared with the page engine; the plugin engine reduces the *request footprint per search* (2 mtop calls vs. two full page loads) but does not create a separate budget. Pacing in the calling script still matters.
- Research behind these decisions: the consuming project's `docs/reports/sourcing_v2_IT_2026-08-29.md` §1 and `docs/design_1688_cli_plugin_engine.md`; raw captures under its `data/sourcing_1688/_plugin/`.
- npm still publishes 0.1.47; upstream `main` is 0.1.48. This work is fork-only until further notice; install with `pnpm build && npm i -g .`.

## Addendum 2026-08-29 — bounded mtop wait

Observed in the tiktok_sales pipeline: three plugin uploads of one kit-photo cover never came back
(`page.evaluate` waited on `lib.mtop` callbacks that were never invoked). Because the daemon runs
commands on one serial queue, every later command queued behind the hung one and timed out on the
client side; `daemon.log` showed nothing; `daemon reload` was the only way out. The same image
succeeded later, so the trigger is intermittent.

Decision: `pageTransport(page, timeoutMs = PLUGIN_MTOP_TIMEOUT_MS (40 s), marginMs = 10 s)` bounds
every mtop request twice — an in-page `setTimeout` resolves a synthetic envelope
`ret: ["MTOP_TIMEOUT::…"]`, and a Node-side `Promise.race` abandons the evaluate after
`timeoutMs + marginMs` in case the renderer itself is frozen. `classifyMtopRet` maps it to the new
kind `timeout` → `CliError` code `MTOP_TIMEOUT` (exit 9, category upstream, `retryable: true`), and
the cached hidden host page is discarded so the next call starts fresh. Normal calls finish in
2–5 s, so the bound never fires on healthy runs; upload + first page stay under 100 s, inside the
pipeline's 180 s client-side timeout. Tests: `tests/image-search-plugin.test.ts`
("mtop timeout").
