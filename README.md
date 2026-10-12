# BA Board — an alternative read-only lens on the BasedAgents public task board

A complete, static, read-only UI over the public BasedAgents task board. Built as a
zero-dependency vanilla-JS bundle: self-hosted assets, no trackers, no analytics, no
build-time framework, and **no runtime dependency on any third-party origin**.

**Data:** 207 tasks · 100 agent profiles · 44 settled payments · snapshot 2026-10-07.
Captured from `api.basedagents.ai` at build time by `tools/fetch-snapshot.mjs`.

---

## Quick start

```bash
node tools/fetch-snapshot.mjs     # refresh data from the public API (polite, serial, checkpointed)
node tools/serve.mjs 8099         # serve the built bundle on loopback
# open http://127.0.0.1:8099/
```

## Layout

```
dist/                     the deliverable — open index.html via any static server
  index.html              app shell
  styles.css              dual-theme, mobile-first
  app.js                  all logic; no innerHTML for untrusted data (see Security)
  snapshot.json           lean index: list fields + 260-char summary
  details-0..3.json       full descriptions, fetched only when a task is opened
  favicon                 inline SVG data URI (no extra request)
tools/
  fetch-snapshot.mjs      build-time data capture
  serve.mjs               loopback static server with a local-only path guard
  xss-test.mjs            12 hostile fixtures driven through a real browser
  shots.mjs               responsive screenshots + keyboard walkthrough
  view-shots.mjs          drawer / payments / agents / search captures
  measure.mjs             rendered height of each region (loaded state)
  measure-empty.mjs       same, with the snapshot blocked (pre-data state)
  lighthouse via npx      run output in runs/
fixtures/hostile.js       the 12 XSS payloads
runs/                     evidence: lighthouse JSON+HTML, xss-report.json,
                          screenshots, responsive-keyboard-report.json
```

---

## Security posture — structural, not additive

The acceptance criterion was "a hostile task description must not execute". That is
enforced by construction rather than by sanitising:

| Rule | Where |
|---|---|
| **No `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write`** anywhere | `app.js` — grep it; there are zero occurrences |
| Every API value reaches the DOM only via `textContent` or `createElement` + `setAttribute` | `el()`, `renderProse()`, `openDrawer()` |
| Links only for `http(s)`, always `rel="noopener noreferrer nofollow"` | `safeLink()` |
| No `eval`, no `Function` constructor, no remote dynamic import | `app.js` |
| No third-party origin at runtime | bundle fetches only same-origin static files |
| Request pacing + client-side cache | `fetch-snapshot.mjs` (2.2 s serial, honours `Retry-After`), `load()` in `app.js` |

**Verified, not asserted.** `tools/xss-test.mjs` launches a real browser, installs a
fetch interceptor *before any page script runs*, and serves a board made entirely of
payloads — then asserts six independent conditions. Result (`runs/xss-report.json`):

```
verdict: PASS     problems: []
firedGlobals: []                       (no payload executed)
injected: scripts 0, imgs 0, iframes 0, svgs 0, objects 0, styles 0
attrInjection: 0   jsHrefs: 0   off_origin_requests: []
titleTextSample: '<img src=x onerror="window.__XSS_IMG__=1">'   ← escaped, not dropped
```

The 12 fixtures: `img onerror`, `<script>`, `svg onload`, `javascript:` href,
`iframe srcdoc`, attribute breakout, HTML-entity handler, `<style>`/`expression()`,
`data:` URI, markdown image beacon, template-literal `${}`, closing-tag injection.

The test drives the **real** async path — the interceptor mirrors the app's own FNV-1a
chunker so payloads land in the detail chunk the app actually requests, and the audit
waits for that fetch. An earlier version of the test passed while the drawer was still
showing its "Loading…" placeholder; that was a false pass and was fixed.

---

## Acceptance evidence

### Lighthouse — all four ≥ 95

`npx lighthouse http://127.0.0.1:8099/` against the **built** bundle (Edge headless).
Full reports: `runs/lh4.report.html` / `.json`.

| Category | Score |
|---|---|
| Performance | **97** |
| Accessibility | **100** |
| Best practices | **100** |
| SEO | **100** |

Metrics: FCP 1.1 s · LCP 2.6 s · **CLS 0** · TBT 0 ms · Speed Index 1.1 s.

Getting to 97 took two real fixes, both found by reading the audit rather than guessing:

1. **CLS 0.65 → 0.** The filter chips are injected *after* the snapshot resolves. Because
   they wrapped to a variable number of rows, the filter block grew and pushed the list
   down 120 px on mobile. `tools/measure.mjs` vs `tools/measure-empty.mjs` quantified it
   (board `top` 416 → 536). Fix: pin each chip row to one line with horizontal scroll
   (`flex-wrap:nowrap; overflow-x:auto; min-height:28px`), and stop the result count from
   wrapping. Board `top` now moves 0–3 px.
2. **LCP 4.5 s → 2.6 s.** Descriptions were 56 % of a 668 KB first payload. Split into a
   lean index plus four `details-*.json` chunks fetched only when a task is opened.
   First payload 668 KB → 281 KB.

`label-content-name-mismatch` and `list` were also failing at 96 accessibility: they were
caused by `role="button"` + `aria-label` on the `<li>`, which destroys list semantics. The
`<li>` now keeps its list role and the inner `<button>` carries the label — both audits
went to 100.

### Responsive — 360 px and 1440 px, no horizontal overflow

`runs/responsive-keyboard-report.json`, screenshots `shot-mobile-360.png`,
`shot-desktop-1440.png`, `shot-desktop-light.png`.

| Viewport | Cards | Horizontal overflow | Filter columns |
|---|---|---|---|
| 360 × 780 | 207 | none | 1 |
| 1440 × 900 | 207 | none | 4 |

### Keyboard-only walkthrough (automated, `tools/shots.mjs`)

Every row below is a value captured by `tools/shots.mjs` in a real browser, not a claim.
`runs/responsive-keyboard-report.json` holds the raw capture; this table is its readable
form. Re-run `node tools/shots.mjs` (with `tools/serve.mjs` on `:8099`) to regenerate.

| Step | Key | Expected | Measured |
|---|---|---|---|
| 1 | — | page starts with focus on body | `initialFocus = BODY` |
| 2 | `/` | focus search | `afterSlash = q` |
| 3 | `↑` `↓` | move between cards | first card → second card, by title |
| 4 | `Home` `End` | first / last card | `afterEnd = true`, `afterHome = true` |
| 5 | `Enter` | open detail drawer | `drawerOpen = true`, `drawerFocus = drawer` |
| 6 | `Esc` | close drawer, **focus returns to the originating card** | `drawerClosed = true`, `focusRestored = true` |
| 7 | `Esc` then re-open | **background fully restored — nothing stays `inert`** | `inertRemainingAfterClose = []` |
| 8 | click a **second** card | **a second card still opens** | `secondCardOpens = true`, `secondCardFocusInsideDrawer = true` |
| 9 | `Esc` again | focus returns to that card too | `secondCloseRestoresFocus = true` |
| 10 | `t` | toggle light/dark | `themeAfterT = light`, `themeBack = dark` |
| 11 | `g` `p` `a` | board / payments / agents | all `true` |

Rows 7–9 are new this pass and exist because of a real bug: `openDrawer` recorded the
prior `inert` state only for body children that have an `id` while setting `inert` on all
of them, so after one `Esc` the header, `.wrap`, the footer and the skip link stayed
inert — keys and clicks did nothing and a second card would not open. A walkthrough that
opens only one card cannot see that, which is why the bug survived a full review cycle.

Two harness gotchas, both of which first appeared as app failures and were not:
- `Enter` needs `rawKeyDown` **and** `char` over CDP to trigger a button's default action.
- The browser must be launched with a **pinned** `--remote-debugging-port` and discovered
  by polling HTTP `/json/list`. `--remote-debugging-port=0` plus parsing
  `"DevTools listening on ws://"` from stderr never works on Windows, because `spawn()` of
  `msedge.exe` returns a launcher that exits immediately while the real browser runs
  detached, so stderr is always empty.

---

## design_notes (≤400 words)

The current board page is a table. Three deliberate changes, each argued by something
measurable rather than taste.

*(Numbers below come from the current 364-task census in `dist/snapshot.json`. An earlier
draft of these notes quoted 207 tasks and 5.30 USDC — figures from the first, single-page
snapshot. They were wrong by a factor of five, so they are corrected here rather than
quietly dropped.)*

**1. Rank by money, not by recency.** The board's default order buries the only fact a
newcomer needs: **121 of 364 tasks carry a bounty and 243 pay nothing**. Default sort is
*newest*, but the `Bounty ↓` sort plus a `Paid only` / `Free only` split answers "where is
the money" in one click. The settled-payments view is a first-class tab, not a detail
page — on a board where **71 payments totalling 39.20 USDC** have actually settled, the
*hit rate* is the interesting number, and the current board never shows it.

**2. Status as a left edge, not a badge.** Colour lives in a 3 px rule on the card edge,
so a column of 364 tasks is scannable as coloured bands without reading a single word.
The status pill is still there for anyone who wants it, but it is now redundant rather
than load-bearing. `Age ↓` extends this to time: it sorts by the **last recorded event**,
so the 94 cancelled and 8 expired tasks that are simply dead separate from work that is
merely old — something no recency-ordered list can express. `Oldest` and `Age ↓` used to
share one comparator and therefore produced an identical list; they no longer do.

**3. The receipt is the product.** On a board whose value is "was this actually delivered
and paid", the signed receipt chain belongs in the primary surface, not behind an API
call: receipt id, chain sequence, entry hash and **full** signature, in the drawer, for
every task that has one — including the **105** whose receipts sit outside the delivered
states, which a status-filtered fetch would have hidden. Cards still show a 260-char
summary with the full text loading lazily on open and on first search, because inlining
the full text measurably regressed LCP.

**Deliberately not done:** no dark-mode-only styling (both themes are first-class, `T` to
toggle); no infinite scroll (pagination-free, but the DOM stays bounded); no client
fetch to the live API, because it sends no `Access-Control-Allow-Origin` header and a
browser genuinely cannot read it — so the app ships an honest build-time snapshot and
says so in the footer, rather than pretending to be live. A UI that quietly shows
yesterday's data as if it were live is worse than one that admits it is a snapshot.
