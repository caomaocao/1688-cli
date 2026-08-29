# Safety

This tool operates a real 1688 buyer account. Some commands read public or
account data; others contact sellers, mutate cart state, submit feedback, or
place orders. Treat write actions as explicit user-authorized operations.

## Exit Codes

| Code | Meaning | Agent behavior |
|---:|---|---|
| 0 | Success | Continue. |
| 2 | Bad invocation | Fix arguments or report the bad input. |
| 3 | Not logged in / session expired | Tell the user to run `1688 login`; do not loop. |
| 4 | Risk control / slider verification | Tell the user to rerun once with `--headed`; do not silently retry. |
| 5 | Another 1688 command is running for the selected profile | Wait only if the task naturally allows it; otherwise report lock busy. |
| 6 | Chromium missing | Report dependency issue. |
| 7 | Login wait timeout | Report timeout. |
| 8 | Login finished but cookies missing | Report login cookie issue. |
| 9 | Network error | Report or retry only when safe and bounded. |
| 130 | User canceled | Stop. |

## Login And Logout

- `1688 login` opens a user-interactive QR/browser flow. Only run it when the
  user explicitly asks to log in.
- In non-interactive sessions, `1688 login` saves a QR PNG to
  `~/.1688/login-qr.png` and prints `QR saved as PNG: <path>` on stderr.
  Surface that file/path to the user and wait for the command to exit.
- Do not open the raw QR URL in a browser.
- `1688 logout --yes` destroys the cached session. Do not pass `--yes` without
  explicit current-turn confirmation.

## Risk Control

- If exit code `4` appears, tell the user to rerun the same command once with
  `--headed`.
- The user must solve the slider manually.
- Do not silently retry the same blocked command.
- `image-search --engine plugin` talks to 1688 through mtop calls instead of
  pages. A risk-control reply there (`RGV587_ERROR…`, `FAIL_SYS_USER_VALIDATE`)
  is reported with the same exit code `4` / `RISK_CONTROL`; a session-expired
  reply (`FAIL_SYS_SESSION_EXPIRED`, `FAIL_SYS_ILLEGAL_ACCESS`,
  `FAIL_SYS_TOKEN_*`) as exit `3` / `NOT_LOGGED_IN`; any other non-success
  code as exit `9` / `UPSTREAM_ERROR` with the original code in
  `details.ret`. None of these are retried automatically, and the engine
  discards its cached host page so the next call starts clean. The engine also
  paces itself (≥ 3 s + jitter between plugin calls) on top of the daemon
  throttle; do not wrap it in tight retry loops.

## Seller Contact

These commands contact real sellers:

```bash
1688 seller inquire <offerId> <message>
1688 seller chat <orderId|loginId> <message>
```

Before sending, show the message and target context unless the user has already
given an explicit current-turn send instruction.

## Cart Mutations

These commands mutate buyer cart state:

```bash
1688 cart add <offerId> --sku <skuId> --qty N
1688 cart remove <cartId>
```

For agent use, show the offer/SKU/quantity or cart row being changed and run
only after the user approves that action.

## Checkout Protocol

`1688 checkout confirm` places a real order. It does not pay automatically, but
it commits the buyer to the seller.

Agent protocol:

1. Run `1688 checkout prepare <cartIds...>`.
2. Show the full preview: total, items, address, seller, and cart IDs.
3. Wait for explicit current-turn approval such as "yes, place it" or
   "下单吧".
4. Run `1688 checkout confirm <cartIds...> --agent`.
5. Report the final order ID and URL.

Never run `--agent` without this prepare plus approval cycle. Never infer
authorization from older messages.

## Feedback Submission

`1688 feedback "<message>"` prepares a GitHub issue URL. That is safe by
default.

`1688 feedback "<message>" --submit` posts publicly through `gh`. Do not add
`--submit` unless the user explicitly asks to submit/post the issue.

## Update Awareness

`1688 doctor --no-launch --json` reports version information. Any JSON-mode
command may also emit an update notice on stderr.

Rules:

- In an interactive session, ask once before running the printed global install
  command.
- In non-interactive loops, do not upgrade automatically.
- After an approved package update, run `1688 daemon reload`.
