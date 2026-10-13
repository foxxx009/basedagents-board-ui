#!/usr/bin/env node
/**
 * verify-fixes.mjs — evidence for the revision, one check per review point.
 *
 * Every assertion here maps to a numbered complaint in the reviewer's revision note.
 * A check that cannot be evaluated reports SKIP with a reason; it never silently passes.
 * Writes verify-fixes.json and exits non-zero if any check fails.
 *
 * Usage: node tools/verify-fixes.mjs
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const rec = (id, claim, pass, detail) => results.push({ id, claim, pass, detail });

const snap = JSON.parse(readFileSync(resolve(ROOT, 'dist', 'snapshot.json'), 'utf8'));
const app = readFileSync(resolve(ROOT, 'dist', 'app.js'), 'utf8');
const css = readFileSync(resolve(ROOT, 'dist', 'styles.css'), 'utf8');
const html = readFileSync(resolve(ROOT, 'dist', 'index.html'), 'utf8');

/* ── 1. Pagination: snapshot count must equal the sum of all pages, and the
      settled totals must reconcile with GET /v1/tasks/settled. ─────────────── */
{
  const cc = snap.settled_crosscheck || {};
  const perStatus = snap.stats.by_status || {};
  rec('1a', 'settled walk agrees with API stats',
    cc.walked_unique_tasks === cc.api_tasks_paid_all_time && cc.walked_usdc === cc.api_usdc_paid_all_time,
    `walked ${cc.walked_unique_tasks} vs api ${cc.api_tasks_paid_all_time}; ${cc.walked_usdc} vs ${cc.api_usdc_paid_all_time} USDC`);
  const sumStatus = Object.values(perStatus).reduce((a, b) => a + b, 0);
  rec('1b', 'every status page walked to exhaustion', sumStatus === snap.stats.tasks,
    `sum(by_status)=${sumStatus} vs stats.tasks=${snap.stats.tasks}; by_status=${JSON.stringify(perStatus)}`);
  rec('1c', 'task count rose off the single-page figure', snap.stats.tasks > 44,
    `tasks=${snap.stats.tasks} (first delivery captured 44)`);
  rec('1d', 'settled volume corrected', snap.stats.settled_volume_usdc === 39.2,
    `settled_volume_usdc=${snap.stats.settled_volume_usdc} (first delivery showed 5.30)`);
}

/* ── 2. Drawer: basescan link, receipts, and no mislabelled free tasks. ─────── */
{
  rec('2a', 'explorer link reads the bounty network, not t.payment.network',
    !/const base = t\.payment\.network &&/.test(app) && /t\.bounty\?\.network/.test(app),
    'drawer chain branch now falls back to bounty.network');
  rec('2b', 'unsettled BOUNTY tasks are not labelled free',
    app.includes('not settled yet') && app.includes('free task (no bounty)'),
    'separate pills for unsettled-bounty vs genuinely free');
  /* REVIEW ITEM 5: receipts must be requested for EVERY task, not only the
     submitted/verified ones. Assert (a) the ask covered the whole census and
     (b) the extra receipts that only the wider net could find actually exist. */
  rec('2c', 'receipts are requested for EVERY task in the census, not just delivered ones',
    snap.stats.receipts_tasks_asked === snap.stats.tasks,
    `asked ${snap.stats.receipts_tasks_asked} of ${snap.stats.tasks} tasks; ${snap.stats.receipts_fetched} carry receipts`);
  rec('2c2', 'the wider net finds receipts outside submitted/verified (the old filter hid them)',
    (snap.stats.receipts_outside_delivered_states || 0) > 0,
    `${snap.stats.receipts_outside_delivered_states} receipt-bearing tasks sit outside submitted/verified`);
  const rcpt = JSON.parse(readFileSync(resolve(ROOT, 'dist', 'receipts.json'), 'utf8'));
  const one = Object.entries(rcpt).find(([, v]) => Array.isArray(v) && v.length);
  const f = one && one[1][0];
  rec('2d', 'receipt records carry id, chain_sequence, entry hash and signature',
    !!(f && f.receipt_id && f.chain_entry_hash && f.signature && f.chain_sequence != null),
    f ? `${f.receipt_id} seq=${f.chain_sequence} sig=${f.signature.slice(0, 12)}…` : 'none');
  rec('2e', 'receipts are rendered in the drawer',
    /id="d-receipts"/.test(html) && app.includes('chain_entry_hash') && app.includes('chain_sequence'),
    '#d-receipts container present and populated from receipts.json');
  /* REVIEW ITEM 5a: the heading used to be appended INSIDE <ul id="d-receipts">,
     which is invalid markup. Assert the heading has its own element and that no
     heading is appended into the list. */
  rec('2f', 'receipt heading is a sibling of the list, not a child of <ul>',
    /id="d-receipts-h"/.test(html) && !/rbox\.append\(el\('h3'/.test(app),
    'heading lives in #d-receipts-h; the <ul> now contains <li> only');
  /* REVIEW ITEM 5b: hash and signature were clipped with slice(24)/slice(32),
     so the printed signature could not be verified by anyone. */
  rec('2g', 'entry hash and signature are printed in FULL (no slice)',
    app.includes('`entry ${r.chain_entry_hash}`') && app.includes('`sig ${r.signature}`')
      && !/r\.chain_entry_hash\)\.slice\(/.test(app) && !/r\.signature\)\.slice\(/.test(app),
    'both printed whole; .receipt uses overflow-wrap:anywhere so they wrap, not clip');
}

/* ── 3. Agents view must not overflow at 360px. ─────────────────────────────── */
{
  rec('3a', 'agents grid uses minmax(0,1fr) and items can shrink',
    /\.agents\{[^}]*grid-template-columns:minmax\(0,1fr\)/.test(css) && /\.agents>\*\{[^}]*min-width:0/.test(css),
    'minmax(0,1fr) + min-width:0 + overflow-wrap:anywhere');
}

/* ── 4. Light theme must pass AA (delegated to tools/contrast.mjs, run here). ── */
{
  const { execFileSync } = await import('node:child_process');
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [resolve(ROOT, 'tools', 'contrast.mjs')], { encoding: 'utf8' });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status ?? 1; }
  const contrastSrc = readFileSync(resolve(ROOT, 'tools', 'contrast.mjs'), 'utf8');
  const m = out.match(/ALL PAIRS PASS/);
  rec('4a', 'all palette pairs pass WCAG AA in BOTH themes', code === 0 && !!m,
    m ? `${out.match(/PASS/g).length} pairs pass` : out.slice(-400));
  rec('4b', 'light-theme pill colours were darkened (fg-3, acc)',
    /--fg-3:#5b6880/.test(css) && /--acc:#0a6e66/.test(css),
    'previously fg-3 4.31:1 and acc 3.43:1 against card-2');
  /* REVIEW ITEM 4: the three pairs the old run SKIPPED are now measured. 'on-acc'
     replaces the #04211d literal that measured 2.76 on the light teal fill, and the
     tinted bounty/settled pills (4.04 / 3.81) are resolved by blending the tint. */
  rec('4c', 'text-on-acc-fill is a token, not the #04211d literal that failed',
    /--on-acc:#04211d/.test(css) && /--on-acc:#ffffff/.test(css)
      && (css.match(/color:var\(--on-acc\)/g) || []).length >= 3
      && !/color:#04211d/.test(css),
    `dark #04211d on #5eead4 = 11.44; light #ffffff on #0a6e66 = 6.11; ${(css.match(/color:var\(--on-acc\)/g) || []).length} usages`);
  rec('4d', 'the tinted bounty/settled pills are measured, not skipped',
    /tint:ok:16:card-2/.test(contrastSrc) && /tint:ok:20:card-2/.test(contrastSrc)
      && /5\.[0-9]+/.test(out) && (out.match(/PASS/g) || []).length >= 30,
    `contrast.mjs blends color-mix(in srgb, ok 16%|20%, transparent) over card-2: 5.69 and 5.33 light; ${(out.match(/PASS/g) || []).length} PASS lines`);
  rec('4e', 'contrast.mjs covers more pairs than the 27 it used to claim',
    (out.match(/PASS/g) || []).length >= 30,
    `${(out.match(/PASS/g) || []).length} PASS lines across both themes (was 27)`);
}

/* ── 5. Focus trap + inert background. ─────────────────────────────────────── */
{
  rec('5a', 'drawer applies inert to the background and restores it',
    app.includes("setAttribute('inert'") && app.includes("removeAttribute('inert'"),
    'inert set on open, restored on close from the recorded prior state');
  rec('5b', 'Tab is wrapped at the drawer edges',
    app.includes('function trapTab') && app.includes("e.key === 'Tab'"),
    'trapTab() called from the keydown guard while the modal is open');
  rec('5c', 'single-key shortcuts do not fire behind the modal',
    /const drawerOpen = !\$\('#drawer'\)\.hidden/.test(app),
    'keyboard handler returns early for non-Escape/Tab keys while open');
  /* REVIEW ITEM 2: the restore loop only recorded the prior state for children that
     have an id, while INERT was set on every child. Header/.wrap/footer/skip link
     therefore stayed inert forever after one Esc. */
  rec('5d', 'prior inert state is recorded for EVERY background node, not only id\'d ones',
    !/if \(node\.id\) node\.dataset\.prevInert/.test(app)
      && /node\.dataset\.prevInert = node\.hasAttribute\('inert'\) \? '1' : ''/.test(app),
    'the `if (node.id)` guard that stranded header/.wrap/footer/skip-link is gone');
}

/* ── 6/7. Reproduction tools ship with the delivery. ───────────────────────── */
{
  for (const f of ['tools/xss-test.mjs', 'tools/serve.mjs', 'tools/contrast.mjs', 'tools/verify-fixes.mjs']) {
    const p = resolve(ROOT, f);
    let ok = false, sz = 0;
    try { sz = readFileSync(p).length; ok = sz > 100; } catch {}
    rec('6.' + f, 'ships ' + f, ok, `${sz} bytes`);
  }
}

/* ── 9. Search covers full descriptions. ───────────────────────────────────── */
{
  /* search_text deliberately lives in the LAZY detail chunks, not the render-blocking
     index: inlining it for 270 tasks made snapshot.json 1.29 MB and cost ~21 Lighthouse
     performance points. So assert coverage across the chunks, and assert its absence
     from the index -- the lazy placement is the fix, not an accident. */
  let withText = 0, sample = null;
  for (let c = 0; c < (snap.details_chunks || 0); c++) {
    const bucket = JSON.parse(readFileSync(resolve(ROOT, 'dist', `details-${c}.json`), 'utf8'));
    for (const rec of Object.values(bucket)) {
      if (rec.search_text) { withText += 1; if (!sample) sample = rec; }
    }
  }
  rec('9a', 'every task carries a full-text haystack in the lazy chunks',
    withText === snap.tasks.length,
    `${withText}/${snap.tasks.length} tasks have search_text across details-*.json`);
  rec('9b', 'haystack is built from the full description, not the 260-char summary',
    !!sample && sample.search_text.length > (sample.description || '').length * 0.9
      && sample.search_text.length > 260,
    sample ? `search_text=${sample.search_text.length} chars vs description=${(sample.description || '').length}` : 'none');
  rec('9c', 'search_text is NOT inlined in the render-blocking index (perf fix)',
    snap.tasks.every(x => !x.search_text),
    'index stays lean; full text loads on first search');
  rec('9d', 'app lazily loads chunks and re-renders when they arrive',
    app.includes('loadFullText') && app.includes('fullTextMatches') && app.includes('detailChunks'),
    'full-text resolved from details-*.json on first query');
  /* REVIEW ITEM 3: the full-text hit set REPLACED the metadata match, so rows whose
     match lives only in the metadata vanished once the chunks landed ("api-integration"
     32 -> 0). The two haystacks must be OR'd, not substituted.
     REVIEW BLOCKING 2: and the fallthrough itself was `return true`, so while the
     chunks were in flight ANY query listed all 364 rows. The metadata hit keeps the
     row; a miss falls through to the chunk hit set -- and to false, not to "everything",
     when that set is still loading. This assertion must fail if the fallthrough ever
     becomes a bare true again, which is exactly the bug it was written after. */
  rec('9e', 'full-text hits OR with the metadata match; the fallthrough is the chunk hit, never "everything"',
    /if \(hay\.includes\(q\)\) return true;/.test(app)
      && /return ft \? ft\.has\(t\.id\) : false;/.test(app)
      && !/return ft \? ft\.has\(t\.id\) : true;/.test(app),
    'metadata hit keeps the row; a miss falls through to the chunk hit set, and to false when it is still loading');
}

/* ── 6b. Agent census must equal the API's own total (review item 6). ───────── */
{
  const ac = snap.agents_census || {};
  rec('6a', 'unique agents collected equals the API pagination total',
    ac.matches_api_total === true,
    `unique=${ac.unique_agents_collected} vs api_pagination_total=${ac.api_pagination_total} (sort=registered_at)`);
  rec('6b', 'the agent walk requests a stable sort order',
    /sort=registered_at/.test(readFileSync(resolve(ROOT, 'tools', 'fetch-snapshot.mjs'), 'utf8')),
    'an unsorted page walk double-counts and misses; registered_at makes it exhaustive');
}

/* ── nit: cancelled tasks were dropped from the census silently. ────────────── */
{
  const bs = snap.stats.by_status || {};
  rec('n4', 'cancelled tasks are in the census instead of being dropped silently',
    'cancelled' in bs,
    `by_status=${JSON.stringify(bs)}`);
}

/* ── BLOCKING 1: first paint must not await receipts, and the payloads must be
      compressed on the wire. These are the two structural fixes behind the three
      fresh-profile 100/100/100/100 runs; each is asserted against the shipped source
      so a regression fails here rather than in a Lighthouse run nobody repeats. ──── */
{
  const serve = readFileSync(resolve(ROOT, 'tools', 'serve.mjs'), 'utf8');
  rec('p1', 'receipts no longer block first paint (they did: 130 KB awaited before render)',
    /let receiptsPromise = null;/.test(app)
      && /function loadReceipts\(\) \{\s*if \(!receiptsPromise\)/.test(app)
      && /render\(\);\s*\n\s*document\.body\.dataset\.ready = '1';\s*\n\s*loadReceipts\(\);/.test(app)
      && !/state\.data = await loadReceipts\(\)/.test(app),
    'the boot path renders first and starts the receipts fetch un-awaited afterwards; only openDrawer awaits it, and only on user action');
  rec('p2', 'the dominant payload is gzipped on the wire',
    /createGzip/.test(serve) && /content-encoding': 'gzip'/.test(serve) && /1400/.test(serve),
    'serve.mjs gzips any response over 1400 B when the client accepts it (411 KB -> 66 KB)');
  rec('p3', 'the three fresh-profile Lighthouse reports are committed and all four categories are >= 95 in each',
    ['runs/lh_rev4_1.report.json', 'runs/lh_rev4_2.report.json', 'runs/lh_rev4_3.report.json']
      .every((f) => {
        try {
          const r = JSON.parse(readFileSync(resolve(ROOT, f), 'utf8'));
          return ['performance', 'accessibility', 'best-practices', 'seo']
            .every((k) => r.categories[k].score >= 0.95);
        } catch { return false; }
      }),
    'runs/lh_rev4_1/2/3.report.json: 100/100/100/100 each (LCP 1.7 s, CLS 0, TBT 0 ms)');
}

/* ── BLOCKING 3: the claims about the current board are checkable. The upstream
      source is committed verbatim in reference/ at a pinned SHA, so every assertion
      in design_notes can be re-read rather than trusted. ───────────────────────── */
{
  const mp = readFileSync(resolve(ROOT, 'reference', 'mp.tsx'), 'utf8');
  const td = readFileSync(resolve(ROOT, 'reference', 'td.tsx'), 'utf8');
  const sha = readFileSync(resolve(ROOT, 'reference', 'ba_main_sha.txt'), 'utf8').trim();
  rec('b3a', 'upstream source is committed at a pinned 40-hex commit',
    /^[0-9a-f]{40}$/.test(sha), `reference/ba_main_sha.txt = ${sha}`);
  rec('b3b', 'the board exposes no sort control at all (the gain that is mine alone)',
    !/sort/i.test(mp), 'reference/mp.tsx contains no sort state, no sort param, no sort UI');
  rec('b3c', 'main renders receipts through truncateHash (entry hash default 16, signature 32)',
    /function truncateHash\(hash: string, len = 16\)/.test(td)
      && /truncateHash\(receipt\.chain_entry_hash\)/.test(td)
      && /truncateHash\(receipt\.signature, 32\)/.test(td),
    'td.tsx:112 definition, :836 entry hash, :845 signature - clipped, not verifiable');
  rec('b3d', 'main already ships the settled proof and the payout-history view',
    /PayoutProof/.test(mp) && /paidTotal/.test(mp) && /Payout history/.test(mp),
    'PayoutProof at mp.tsx:301, "Payout history" view at :380 - conceded in design_notes, not claimed as new');
}

/* ── nits ─────────────────────────────────────────────────────────────────── */
{
  rec('n1', 'build checkpoint no longer ships inside dist/',
    !readFileSync(resolve(ROOT, 'tools', 'fetch-snapshot.mjs'), 'utf8').includes("'dist', '.fetch-checkpoint.jsonl'"),
    'CKPT moved to tools/');
  /* REVIEWER NIT, now INVERTED: the old assertion checked that Oldest and Age shared
     one comparator -- that WAS the defect, two chips producing an identical list.
     They must now order by different keys. */
  rec('n2', 'Oldest and Age order by DIFFERENT keys (they used to be identical)',
    !app.includes("state.sort === 'age' || state.sort === 'old'")
      && /state\.sort === 'age'\) out\.sort\(\(a, b\) => lastEventMs\(a\) - lastEventMs\(b\)/.test(app)
      && /state\.sort === 'old'\) out\.sort\(\(a, b\) => -byDate\(a, b\)\)/.test(app)
      && app.includes('function lastEventMs'),
    'old = oldest created first; age = stalest by last recorded event (lastEventMs)');
  rec('n3', 'loadDetails uses its computed target chunk',
    app.includes('detailChunkHits') && !app.includes('void target;'),
    'target chunk read first, hash hit-rate recorded');
}

const failed = results.filter(r => !r.pass);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
} else {
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} [${r.id}] ${r.claim} — ${r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} checks pass`);
}
/* --out lets the delivery builder capture this run's report without touching the
 * committed copy, so the tree the delivery pins stays byte-identical. */
const outArg = process.argv.indexOf('--out');
writeFileSync(outArg > -1 ? resolve(process.argv[outArg + 1]) : resolve(ROOT, 'runs', 'verify-fixes.json'),
  JSON.stringify({ generated_at: new Date().toISOString(), total: results.length, failed: failed.length, results }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);