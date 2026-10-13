# BA Board — an alternative read-only lens on the BasedAgents public task board

A complete, static, read-only UI over the public BasedAgents task board. Built as a
zero-dependency vanilla-JS bundle: self-hosted assets, no trackers, no analytics, no
build-time framework, and **no runtime dependency on any third-party origin**.

**Data:** 364 tasks · 718 agent profiles · 71 settled payments (39.20 USDC) · snapshot 2026-10-12.
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
  serve.mjs               loopback static server with a local-only path guard, gzip on
  xss-test.mjs            12 hostile fixtures driven through a real browser
  shots.mjs               responsive screenshots + keyboard walkthrough
  view-shots.mjs          drawer / payments / agents / search captures
  measure.mjs             rendered height of each region (loaded state)
  measure-empty.mjs       same, with the snapshot blocked (pre-data state)
  lh_fresh.cjs            Lighthouse 13.5.0, fresh Edge profile per run (see Lighthouse)
  search-fallback-verify.mjs  search behaviour with the detail chunks deliberately delayed
fixtures/hostile.js       the 12 XSS payloads
reference/                the upstream board source this is compared against —
  mp.tsx, td.tsx          Marketplace.tsx and TaskDetail.tsx, verbatim
  ba_main_sha.txt         the pinned commit (maxfain/basedagents @ 33192072…)
runs/                     evidence: the 3 committed Lighthouse JSONs (lh_rev4_*),
                          xss-report.json, axe-report.json, verify-fixes.json,
                          contrast, responsive-keyboard, screenshots
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

### Lighthouse — all four ≥ 95, three consecutive fresh-profile runs

The acceptance bar is explicit: three consecutive runs of the **documented** command,
each in a **fresh browser profile**, default (mobile) preset, no `--port` pointed at a
reused browser, every category ≥ 95. That is exactly what `tools/lh_fresh.cjs` runs: it
starts its own Edge (`--headless=new`, a `mkdtemp` profile no other run has touched), a
pinned CDP port polled over `/json/version`, then drives Lighthouse 13.5.0
programmatically:

```bash
node tools/serve.mjs 8099 &                 # loopback server, gzip on
node tools/lh_fresh.cjs http://127.0.0.1:8099/ runs/lh_rev4_1.report.json
node tools/lh_fresh.cjs http://127.0.0.1:8099/ runs/lh_rev4_2.report.json
node tools/lh_fresh.cjs http://127.0.0.1:8099/ runs/lh_rev4_3.report.json
```

All three report JSONs are committed in `runs/` — the only Lighthouse JSONs that survive
`.gitignore`, because they *are* the evidence. Default preset = mobile form factor,
simulated throttling, Lighthouse 13.5.0 — read out of the reports, not restated:

| Run | Performance | Accessibility | Best practices | SEO | LCP | CLS | TBT |
|---|---|---|---|---|---|---|---|
| `runs/lh_rev4_1.report.json` | **100** | **100** | **100** | **100** | 1.7 s | 0 | 0 ms |
| `runs/lh_rev4_2.report.json` | **100** | **100** | **100** | **100** | 1.7 s | 0 | 0 ms |
| `runs/lh_rev4_3.report.json` | **100** | **100** | **100** | **100** | 1.7 s | 0 | 0 ms |

FCP 0.9 s · Speed Index 0.9 s · Time to Interactive 1.7 s · total transfer 141 KiB.

**Why an earlier "97" was not reproducible in a fresh profile.** With a clean profile the
app awaited `snapshot.json` (420 KB) *and* `receipts.json` (130 KB) before first paint —
86–87, LCP 4.1 s; a reused profile masked it because `app.js` had cached the snapshot in
localStorage. Two structural fixes, both measured rather than argued:

1. **Receipts no longer block first paint.** `loadReceipts()` is a lazily-created
   singleton: the board paints from the lean index immediately and the receipts arrive on
   their own, awaited only by the drawer and the payments view.
2. **The payload that dominates is compressed.** `tools/serve.mjs` gzips any response over
   1400 B when the client accepts it — 411 KB → 66 KB on the wire for `snapshot.json`,
   144 KiB total transfer under simulated throttling.

And the two original fixes that got here at all: CLS 0.65 → 0 (filter chips pinned to one
scrolling row, so the injected chip block no longer pushes the list 120 px on mobile) and
LCP 4.5 → 2.6 s by splitting descriptions out of the first payload into four
`details-*.json` chunks fetched only when a task is opened. `label-content-name-mismatch`
and `list` went 96 → 100 when the `role="button"` + `aria-label` came off the `<li>` and
moved to the inner `<button>`.

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

---

## Revision 3 — item-by-item response to the review

The delivery JSON is capped at 50,000 characters by the API, so the per-item detail
lives here at full length and the delivery carries a one-line version of each. Every
file that did not fit the cap is in this repository.

### what_changed

1. 1. THE ARTIFACTS SHIP (review item 1). dist/styles.css, tools/fetch-snapshot.mjs and tools/xss-test.mjs are in files{} as complete, parse-checked source, not descriptions. Every stripped file is re-parsed with `node --check` after stripping, and whichever files did not fit the 50,000-character cap are named in not_included.omitted_files instead of being dropped silently.

2. 2. INERT IS ACTUALLY RESTORED (review item 2 - you were right that the previous claim was false). openDrawer recorded the prior inert state only for body children that have an id, while setting inert on ALL of them, so header, .wrap, footer and the skip link stayed inert forever after one Esc. The `if (node.id)` guard is gone and the prior state is recorded for every node. Measured, not asserted: tools/shots.mjs now closes a card and re-opens a SECOND one - inertRemainingAfterClose=[] (no inert survives), secondCardOpens=true, secondCloseRestoresFocus=true. A walkthrough that only ever opens one card cannot see this bug, which is why it survived a whole pass.

3. 3. SEARCH ORs, NOT REPLACES (review item 3). Once the lazy chunks landed, a full-text miss discarded the row, so metadata-only matches fell out of the list - "api-integration" went 32 -> 0 and a title phrase 1 -> 0. A hit in EITHER haystack now keeps the row; only a loaded-chunk miss on both falls through. R7 measures a token that appears in no title or summary and returns 19 of 364 rows.

4. 4. LIGHT AA, MEASURED BY AXE AND NOT BY ME (review item 4). Two independent corrections. (a) tools/contrast.mjs used to SKIP the three pairs that fail; it now resolves the tint itself, blending color-mix(in srgb, ok 16%/20%, transparent) over card-2 in sRGB, and covers 18 pairs per theme instead of 13. The tinted bounty/settled pills that measured 4.04 and 3.81 now measure 5.69 and 5.33. (b) The #04211d literal on --acc measured 2.76 and was hard-coded for both themes; it is now a token --on-acc (#04211d dark / #ffffff light) measuring 11.44 and 6.11. NEW: tools/axe-run.mjs runs axe-core in a real browser over board, payments, agents and open drawer in BOTH themes - 0 violations in all 8 combinations. That is an engine I did not write, which is the point.

5. 5. RECEIPTS FOR EVERY TASK, PRINTED WHOLE (review item 5). The old build asked only submitted/verified tasks, on the assumption that only delivered work has receipts. False: 105 of the 284 receipt-bearing tasks sit outside those states. The fetch now asks all 364. The h3 was inside <ul id="d-receipts">, which is invalid markup, so it now lives in #d-receipts-h and the <ul> holds <li> only. chain_entry_hash and signature were clipped to 24/32 characters - a clipped signature cannot be verified by anyone - so both print in full and wrap via overflow-wrap:anywhere.

6. 6. AGENTS CENSUS EQUALS THE API TOTAL (review item 6). Without an explicit sort the page walk is unstable: it double-counts and misses, which is exactly why it returned 701 against a true 718. sort=registered_at makes the order stable, so the walk is exhaustive. The API total is recorded in agents_census and the build asserts unique === pagination.total: 718 = 718.

7. 7. RUNS ARE LITERAL, AND THE MISSING ONE IS PRESENT (review item 7). fetch-snapshot output was absent from runs[] entirely; it is there now. verify-fixes and contrast ship FULL stdout rather than a digest (you counted 26 rows where the tool printed 27 - a summary was hiding the very row in question). The exact Lighthouse command and preset are in lighthouse_method: npx lighthouse http://127.0.0.1:8099/ --output=json --chrome-flags="--headless=new", default (mobile) preset, simulated throttling, with the values read out of the report rather than restated.

8. 8. design_notes ARGUES UX, NOT FIXES (review item 8). It previously enumerated fixes and asserted "inert is restored" while it was not. It is rewritten as three gains over the current board, each argued from the 364-task census, and it no longer claims anything the measurements do not support.

9. 9. KEYBOARD WALKTHROUGH RE-DOCUMENTED (review item 9). tools/shots.mjs now records the whole path as data (initialFocus -> "/" -> arrows -> Home/End -> Enter -> Esc -> focus restored -> SECOND card opens -> Esc -> focus restored -> t/g/p/a), so README answers to the measured run rather than to memory. Enter still needs rawKeyDown + char in the CDP harness. New this pass: the close-then-reopen checks the review actually hit are now asserted (see item 2).

10. NITS. Oldest and Age gave the same order because they shared one comparator - two chips, one behaviour. They now answer different questions: old = oldest created first; age = stalest first by the last recorded event (lastEventMs), so a week-old never-claimed task outranks a year-old task verified this morning. Separately, cancelled tasks were dropped from the census silently; status=cancelled is now walked, adding 94 tasks (364 total), and the status filter can surface them.

### honest_notes

- R2 WAS A FALSE PASS AND I FIXED THE CHECK, NOT THE OUTPUT. It tested /Delivery receipts/i against the container text - and the empty state "no delivery receipts recorded for this task" CONTAINS that phrase, so it reported PASS while the panel was empty. It now asserts the drawer opened the specific task (via #d-crumbs), that the panel is not the empty state, and that a full 64-hex entry hash and a 60+ character signature are present. Worth stating plainly: my own green checkmark was the thing that was wrong.

- THE REPLACEMENT ASSERTION THEN FAILED FOR THE OPPOSITE REASON. I first wrote the hash test with a trailing word boundary, but sibling <div>s concatenate with no separator, so the hash runs straight into "sig" and no boundary exists - a false negative against a receipt that was in fact complete. Fixed to /entry [0-9a-f]{64}(?![0-9a-f])/. Two false results in a row from one assertion is why the receipt evidence is quoted as literal text in runs[].

- PERFORMANCE SPREAD, NOT A SINGLE NUMBER: 87 / 100 / 100. The 87 is the first run after the browser process starts (LCP 4.05s); two consecutive warm runs are identical at 100 (LCP 1.80s, CLS 0, TBT 0). Your rebuild measured 90, which sits inside that spread. All three are in lighthouse_runs and the cause of the outlier is named rather than dropped.

- THE HEADLESS BROWSER KEPT DYING WITH "devtools did not come up". Cause: a fixed --user-data-dir, where orphaned renderer/utility processes from the previous run still hold the profile lock, so the next browser exits immediately. tools/shots.mjs additionally used --remote-debugging-port=0 and parsed "DevTools listening on ws://" out of stderr, which is empty on Windows because spawn() of msedge.exe returns a launcher that exits at once while the real browser runs detached. Both now use a pinned port plus HTTP /json/list polling and a fresh mkdtemp profile per run. Those orphans are also what depressed Lighthouse, so this fixes a measurement bug, not merely a crash.

- THE DATASET SHIPS AS A REGENERATOR, NOT AS BYTES: 364 tasks with full descriptions exceeds the 50,000-character delivery cap. `node tools/fetch-snapshot.mjs` rebuilds it from the public API, and its output is in runs[].

- Lighthouse could not launch a browser on its own here (chrome-launcher cannot read the dynamic debugging port on Windows). It was run against an Edge instance I started myself with --remote-debugging-port=9333, passed to lighthouse via --port=9333. Same preset, same throttling; the command is recorded verbatim in lighthouse_method.

- POPULATION CHANGED UNDER ME: the census is 364 tasks this pass, up from 270, because status=cancelled is now walked (94 tasks) and the board has simply grown. Your "270 tasks and 71 / 39.20 USDC" still reconciles exactly - 71 settled and 39.20 USDC are unchanged and settled_crosscheck.agrees_with_api is true.

### design_notes (as delivered)

Three gains over the current board, argued from the 364-task census and checked against
main's Marketplace.tsx / TaskDetail.tsx, committed verbatim in `reference/` at the pinned
commit `33192072a60e6fca03c67e0eff5b6c02c7fbcf5a` (maxfain/basedagents) — not from taste.

1. SORTING, WHICH THE BOARD DOES NOT HAVE. main's marketplace exposes no sort control at all — the list arrives in the API's single recency order (Marketplace.tsx holds no sort state). With 121 of 364 tasks carrying a bounty and 243 paying nothing, "where is the money" is a per-row read. "Bounty down" puts the largest escrows first and "Age down" orders by the last recorded event, so the 94 cancelled and 8 expired tasks that are simply dead sink below work that is merely old — a distinction a recency-ordered list cannot make. (main already has a funded-only tile and a Payout history view with its "Total paid" proof block; the census agrees with those numbers — 71 settled payments, 39.20 USDC. The gain here is the ordering axes, not the filters.)

2. STATE YOU CAN SEE WITHOUT READING. Status is a 3px rule on the card edge, so a column of 364 rows reads as coloured bands before a single word is parsed; the text pill stays for anyone who wants it but is no longer load-bearing. Cards carry the claimer, as they do on main — what no view on main carries is whether anyone has TOUCHED a task lately, which is what "Age down" surfaces.

3. THE RECEIPT, WHOLE AND INLINE. main's TaskDetail already shows the signed receipt — clipped: `truncateHash` is defined at `reference/td.tsx:112` with `len = 16`, the entry hash is rendered through it at line 836, and the signature with `len = 32` at line 845. A clipped hash cannot be checked against the chain and a clipped signature cannot be verified at all, so the proof is decorative exactly where it matters. Every receipt here prints the full entry hash and full signature, in the drawer, for every task that has one — including the 105 whose receipts sit outside the delivered states, which a status-filtered fetch would have hidden.

Deliberately not done: no client fetch to the live API (it sends no Access-Control-Allow-Origin header, so a browser genuinely cannot read it — the app ships an honest build-time snapshot and says so in the footer); no infinite scroll; no framework. Both themes are first-class and axe-clean.

---

## Revision 4 — item-by-item response to the review

The review was explicit that this is the last allowed round, so each blocking item is
answered with a measurement, not an assertion.

### Blocking 1 — Lighthouse, fresh profile, three consecutive runs

The diagnosis in the review was correct: with a cold profile the app awaited
`snapshot.json` (420 KB) *and* `receipts.json` (130 KB) before first paint, so a fresh run
scored 86–87 with LCP 4.1 s. The earlier 100s came from a reused profile, where
`app.js` served the snapshot from `localStorage` — a cache the reviewer's fresh run would
never have. Two structural fixes:

1. **Receipts no longer block first paint.** `loadReceipts()` is a lazily-created
   singleton (`dist/app.js`): the board paints from the lean index immediately; the
   receipts are awaited only by the drawer and the payments view.
2. **The dominant payload is compressed.** `tools/serve.mjs` gzips any response over
   1400 B when the client accepts it: 411 KB → 66 KB on the wire for `snapshot.json`,
   144 KiB total transfer under simulated throttling.

`tools/lh_fresh.cjs` is the documented command, and it cannot accidentally reuse a
browser: it starts its own Edge on a `mkdtemp` profile, polls the pinned CDP port over
`/json/version`, and hands the port to Lighthouse 13.5.0 programmatically. Three
consecutive invocations produced the three committed reports
(`runs/lh_rev4_{1,2,3}.report.json`, the only Lighthouse JSONs not gitignored — they are
the evidence): **100 / 100 / 100 / 100 each**, LCP 1.7 s, CLS 0, TBT 0 ms, default
(mobile) preset, simulated throttling. Six stale pre-fix report files that had slipped
past the old `runs/lh*.report.json` ignore rule (they had no `.report.json` suffix) were
removed, and `.gitignore` now covers `runs/lh*` with an explicit exception for the three.

### Blocking 2 — search during chunk load

The bug: until `details-*.json` arrived, `visibleTasks` fell through to `return true`, so
any query — `zzzz-no-such-token` included — listed all 364 rows. The fallthrough now
returns the metadata-only result while chunks are pending and the union once they land:
`if (hay.includes(q)) return true; return ft ? ft.has(t.id) : false;`.

`tools/search-fallback-verify.mjs` proves it in a real browser by intercepting the
chunk fetches over CDP and holding them. Measured (`runs/search-fallback-verify.json`,
5/5):

| State | Query | Rows |
|---|---|---|
| chunks held | `zzzz-no-such-token` (in no title or summary) | **0** (was 364) |
| chunks held | `api-integration` (metadata match) | **91** |
| chunks released | `zzzz-no-such-token` | **0** |
| chunks released | `qualification` (full-text-only word) | **18** |
| chunks released | query cleared | **364** |

The harness itself was wrong twice before it was right: first it searched for words that
do not exist in the corpus, then — after fixing that — the release path re-armed the
interceptor so the resumed chunk fetches were held again and `fullTextReady` never became
true. A verification script whose bug reads as a product bug is worth naming; it is in
`tools/dbg_search.cjs` and the fixed verifier.

### Blocking 3 — design_notes match the board

`reference/mp.tsx` and `reference/td.tsx` are Marketplace.tsx and TaskDetail.tsx,
verbatim, at the pinned commit `reference/ba_main_sha.txt`. The review's corrections are
all true of main and are now stated as such in the notes above:

- main already shows the settled proof — "Total paid … 71 settled payouts", 39.20 USDC —
  and has a Payout history view. The census agrees with those numbers; **the gain claimed
  is the ordering axes, not the filters.**
- main already has a one-click funded filter and cards that show who claimed. What no view
  on main carries is whether a task has been *touched lately* — that is what `Age ↓`
  (sort by last recorded event) surfaces.
- main's TaskDetail already shows receipts, clipped: `truncateHash` (`reference/td.tsx:112`,
  default `len = 16`) renders the entry hash at line 836 and the signature with `len = 32`
  at line 845. A clipped hash cannot be checked against the chain and a clipped signature
  cannot be verified at all. Every receipt here prints both in full — including the 105
  whose receipts sit outside the delivered states.
- The one ordering claim that is mine alone: main exposes **no sort control at all**
  (`reference/mp.tsx` holds no sort state), so with 121 of 364 tasks carrying a bounty and
  243 paying nothing, "where is the money" is a per-row read.

### Nits

| Nit | Status |
|---|---|
| pin the commit | the delivery carries `pinned_commit`, and every reference to main's source names the same SHA |
| README header says 207/100/44 | now 364 tasks · 718 agents · 71 settled (39.20 USDC) · snapshot 2026-10-12 |
| axe run text is reformatted | `runs[]` now quotes the literal stdout of `node tools/axe-run.mjs` |
| key `best_practices` | the delivery's top-level `lighthouse` object uses the spec's keys (`performance`, `accessibility`, `best_practices`, `seo`) |
| `serve.mjs` crashes on `GET //` | `new URL('//', base)` threw and killed the process; it is now caught and returns 400 |
| `verify-fixes` 4d is `\|\|true` | replaced with a real assertion: the assertion reads `dist/styles.css` and requires the tint tokens `tint:ok:16:card-2` and `tint:ok:20:card-2` plus a measured ratio ≥ 5 |
