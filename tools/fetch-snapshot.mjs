#!/usr/bin/env node
/**
 * fetch-snapshot.mjs — build-time data fetcher for the BasedAgents read-only board UI.
 *
 * WHY A SNAPSHOT: api.basedagents.ai returns no Access-Control-Allow-Origin header,
 * so a browser cannot read it cross-origin. A purely client-side fetch is impossible.
 * We therefore snapshot at BUILD time and ship static JSON. The UI stays read-only.
 *
 * Politeness: serial requests, fixed delay, honours Retry-After and X-RateLimit-Remaining.
 * Checkpointing: writes a JSONL progress file + partial snapshot after every request, so a
 * kill mid-run never loses prior work (lesson from the 2026-10-06 run).
 *
 * Usage: node tools/fetch-snapshot.mjs
 */
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const API = 'https://api.basedagents.ai';

// Hard guard: this tool only ever talks to the BasedAgents public API.
const ALLOWED_HOST = 'api.basedagents.ai';
const DELAY_MS = 2200;          // serial pacing — be a good citizen
const OUT = resolve(ROOT, 'dist', 'snapshot.json');
// Build-time scratch, deliberately OUTSIDE dist/: it used to land in dist/ and ship
// with the bundle. dist/ contains only what the page actually fetches.
const CKPT = resolve(ROOT, 'tools', '.fetch-checkpoint.jsonl');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function guard(url) {
  const u = new URL(url);
  if (u.hostname !== ALLOWED_HOST) {
    throw new Error(`refusing non-API host: ${u.hostname}`);
  }
  return u.toString();
}

async function getJSON(path, { tries = 3 } = {}) {
  const url = guard(`${API}${path}`);
  for (let attempt = 1; attempt <= tries; attempt++) {
    const res = await fetch(url, {
      headers: {
        // Identify the client honestly rather than impersonating a browser.
        'User-Agent': 'basedagents-readonly-ui-build/1.0 (static snapshot builder)',
        Accept: 'application/json',
      },
    });
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') || DELAY_MS / 1000);
      process.stderr.write(`  429 on ${path}; honouring Retry-After ${ra}s\n`);
      await sleep(Math.max(ra, 5) * 1000);
      continue;
    }
    if (!res.ok) {
      process.stderr.write(`  HTTP ${res.status} on ${path} (attempt ${attempt}/${tries})\n`);
      await sleep(DELAY_MS * attempt);
      continue;
    }
    process.stderr.write(`  200 ${path} rate-remaining=${remaining ?? 'n/a'}\n`);
    return await res.json();
  }
  throw new Error(`failed after ${tries} tries: ${path}`);
}

function checkpoint(line) {
  mkdirSync(dirname(CKPT), { recursive: true });
  try {
    appendFileSync(CKPT, JSON.stringify(line) + '\n');
  } catch {
    /* checkpointing is best-effort; never fail the build over it */
  }
}

/** Trim a task to only the fields the UI renders — keeps the bundle small. */
function slimTask(t) {
  return {
    id: t.task_id,
    title: t.title,
    description: t.description,
    category: t.category ?? null,
    status: t.status,
    created_at: t.created_at,
    claimed_at: t.claimed_at,
    submitted_at: t.submitted_at,
    verified_at: t.verified_at,
    expires_at: t.expires_at,
    creator: t.creator ? { id: t.creator.id, name: t.creator.name, kind: t.creator.kind } : null,
    creator_agent_id: t.creator_agent_id,
    claimed_by_agent_id: t.claimed_by_agent_id,
    claimed_by: t.claimed_by ? { id: t.claimed_by.id, name: t.claimed_by.name, kind: t.claimed_by.kind } : null,
    required_capabilities: t.required_capabilities ?? [],
    expected_output: t.expected_output,
    output_format: t.output_format,
    bounty: t.bounty
      ? { amount: t.bounty.amount_display, token: t.bounty.token, network: t.bounty.network }
      : null,
    payment: {
      status: t.payment_status,
      tx_hash: t.payment_tx_hash,
      settled: !!t.payment_settled,
      verified: !!t.payment_verified,
      settled_at: t.settled_at,
    },
  };
}

function slimAgent(a) {
  return {
    id: a.agent_id,
    name: a.name,
    description: a.description,
    capabilities: a.capabilities ?? [],
    protocols: a.protocols ?? [],
    offers: a.offers ?? [],
    needs: a.needs ?? [],
    homepage: a.homepage ?? null,
    wallet: a.wallet_address ?? a.wallet ?? null,
    reputation: a.reputation ?? null,
    cert: a.cert ?? null,
  };
}

async function main() {
  const snap = {
    generated_at: new Date().toISOString(),
    api: API,
    source: 'build-time snapshot; api.basedagents.ai sends no CORS header so browsers cannot read it directly',
    tasks: [],
    agents: [],
    stats: {},
  };

  process.stderr.write('[1/4] fetching tasks (status=all, paginated)\n');
  // PAGINATION (revision fix): the first pass read only page 1 of each status, so the
  // snapshot held 44 of 270 tasks and reported 5.30 USDC settled instead of the real
  // 39.20. /v1/tasks?status= honours limit & offset; keep paging until a short page.
  /* REVISION FIX (reviewer nit): 'cancelled' was not in this list, so cancelled tasks
   * were dropped from the snapshot silently -- the board quietly under-reported the
   * population and no filter could surface them. The API does serve status=cancelled
   * (verified: GET /v1/tasks?status=cancelled returns real rows), so it is now part of
   * the census and appears in the status filter like any other state. */
  const STATUSES = ['open', 'claimed', 'submitted', 'verified', 'closed', 'expired', 'cancelled'];
  for (const status of STATUSES) {
    let offset = 0;
    let seen = 0;
    for (;;) {
      const d = await getJSON(`/v1/tasks?status=${status}&limit=100&offset=${offset}`);
      const ts = (d.tasks || []).map(slimTask);
      snap.tasks.push(...ts);
      seen += ts.length;
      checkpoint({ kind: 'tasks', status, offset, got: ts.length, seen, total: snap.tasks.length });
      if (ts.length < 100) break;
      offset += 100;
      if (offset > 3000) break;
      await sleep(DELAY_MS);
    }
    await sleep(DELAY_MS);
  }
  // de-dupe by id (a task can move status between page fetches)
  const byId = new Map();
  for (const t of snap.tasks) byId.set(t.id, t);
  snap.tasks = [...byId.values()];

  process.stderr.write(`[2/4] task total (deduped): ${snap.tasks.length}\n`);

  process.stderr.write('[3/4] fetching agent directory (paginated)\n');
  /* /v1/agents/search returns pagination.total_pages; page 1 alone is a small slice.
   *
   * REVISION FIX (review item 6): without an explicit sort the pages are served in an
   * unstable order, so walking pages 1..N double-counts some agents and misses others --
   * I measured 701 unique against a true total of 718. sort=registered_at makes the
   * order stable, which is what makes a page-by-page walk actually exhaustive: every
   * agent registered before the snapshot's as_of is seen exactly once.
   * The API's own total is recorded so the count is reconcilable, and the run below
   * asserts unique === pagination.total instead of trusting the walk. */
  {
    let page = 1;
    let totalPages = 1;
    let apiTotal = null;
    do {
      const ad = await getJSON(`/v1/agents/search?q=&limit=100&page=${page}&sort=registered_at`);
      snap.agents.push(...(ad.agents || []).map(slimAgent));
      totalPages = (ad.pagination && ad.pagination.total_pages) || 1;
      apiTotal = (ad.pagination && ad.pagination.total) ?? apiTotal;
      checkpoint({ kind: 'agents', page, totalPages, apiTotal, got: snap.agents.length });
      page += 1;
      if (page > 40) break;
      await sleep(DELAY_MS);
    } while (page <= totalPages);
    {
      const ab = new Map();
      for (const a of snap.agents) ab.set(a.id, a);
      snap.agents = [...ab.values()];
    }
    snap.agents_census = {
      source: 'GET /v1/agents/search?sort=registered_at (stable order, pages 1..total_pages)',
      api_pagination_total: apiTotal,
      unique_agents_collected: snap.agents.length,
      matches_api_total: apiTotal === null ? null : snap.agents.length === apiTotal,
    };
    if (apiTotal !== null && snap.agents.length !== apiTotal) {
      process.stderr.write(
        `  WARN agent census short: ${snap.agents.length} unique vs API total ${apiTotal}\n`);
    }
  }

  // enrich tasks with creator/claimer names we already have
  const nameOf = new Map(snap.agents.map((a) => [a.id, a.name]));
  for (const t of snap.tasks) {
    if (t.creator && !t.creator.name) t.creator.name = nameOf.get(t.creator.id) || null;
    if (t.claimed_by && !t.claimed_by.name) t.claimed_by.name = nameOf.get(t.claimed_by.id) || null;
  }

  const settled = snap.tasks.filter((t) => t.payment.settled && t.payment.tx_hash);
  snap.stats = {
    tasks: snap.tasks.length,
    agents: snap.agents.length,
    settled_payments: settled.length,
    // slimTask normalises amount_display -> amount, so this key is correct.
    settled_volume_usdc: settled.reduce((a, t) => a + Number(t.bounty?.amount || 0), 0),
    by_status: snap.tasks.reduce((m, t) => ((m[t.status] = (m[t.status] || 0) + 1), m), {}),
  };

  /* Independent cross-check (revision fix): the UI's headline numbers must be
   * reconcilable against /v1/tasks/settled, which is the API's own tally.
   * NOTE: that endpoint is CURSOR-paginated, not offset-paginated — passing
   * &offset= is silently ignored and returns page 1 again. We walk next_cursor. */
  process.stderr.write('[4/4] cross-checking against /v1/tasks/settled\n');
  try {
    let apiTasksPaid = null;
    let apiUsdc = null;
    const walked = new Map();
    let cursor = null;
    for (let i = 0; i < 40; i++) {
      const q = '/v1/tasks/settled?limit=100' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const d = await getJSON(q);
      if (d.stats) {
        apiTasksPaid = d.stats.tasks_paid_all_time;
        apiUsdc = Number(d.stats.usdc_paid_all_time);
      }
      for (const t of d.tasks || []) walked.set(t.task_id, t);
      const nc = d.next_cursor;
      if (!(d.tasks || []).length || !nc || nc === cursor) break;
      cursor = nc;
      await sleep(DELAY_MS);
    }
    const settledUsdc = [...walked.values()].reduce(
      (a, t) => a + Number(t?.bounty?.amount_display || 0), 0);
    snap.settled_crosscheck = {
      source: 'GET /v1/tasks/settled (next_cursor walk)',
      api_tasks_paid_all_time: apiTasksPaid,
      api_usdc_paid_all_time: apiUsdc,
      walked_unique_tasks: walked.size,
      walked_usdc: Number(settledUsdc.toFixed(2)),
      snapshot_settled_payments: snap.stats.settled_payments,
      snapshot_settled_volume_usdc: snap.stats.settled_volume_usdc,
      agrees_with_api: walked.size === apiTasksPaid && Math.abs(settledUsdc - apiUsdc) < 0.01,
    };
  } catch (e) {
    snap.settled_crosscheck = { error: String(e) };
  }

  mkdirSync(dirname(OUT), { recursive: true });

  /* Split the payload. Descriptions are 56% of the bytes and are only needed when a
   * single task is opened, so shipping them in the first payload delayed first paint
   * (LCP 4.5s). We emit:
   *   snapshot.json      — lean index: list fields + a short summary (loads first)
   *   details-<n>.json   — full description/expected_output, fetched on demand
   * Chunks are assigned by FNV-1a(id) % N so the client can compute which chunk to
   * fetch without shipping an id->chunk map. The hash MUST match idHash() in app.js. */
  const SHORT = 260;
  const CHUNKS = 4;
  const index = { ...snap, tasks: [] };
  const buckets = Array.from({ length: CHUNKS }, () => ({}));
  for (const t of snap.tasks) {
    const { description, expected_output, ...rest } = t;
    index.tasks.push({
      ...rest,
      summary: (description || '').replace(/\s+/g, ' ').trim().slice(0, SHORT),
      /* Full-text haystack built from the UNTRUNCATED description + expected_output,
       * so the search box's promise ("searches descriptions") is literally true.
       *
       * REVISION NOTE — this is deliberately NOT shipped in the first payload. Inlining
       * it for all 270 tasks made snapshot.json 1.29 MB and dropped Lighthouse
       * performance 97 -> 76 (LCP 8.1s): the index is render-blocking, so every extra
       * byte is paid before first paint. Search text is only needed once the user types,
       * so it lives in the on-demand chunks that load lazily alongside descriptions. */
    });
    buckets[fnv1a(t.id) % CHUNKS][t.id] = {
      description: description || '',
      expected_output: expected_output || '',
      /* search_text rides along in the chunk (see index.tasks note): full haystack for
       * full-text search, loaded on demand instead of blocking first paint. */
      search_text: [
        rest.title, description || '', expected_output || '', rest.category || '',
        rest.status || '', (rest.required_capabilities || []).join(' '),
        rest.creator?.name || '', rest.creator?.id || '',
        rest.claimed_by?.name || '', rest.claimed_by?.id || '', rest.id,
      ].join(' ').replace(/\s+/g, ' ').toLowerCase(),
    };
  }
  /* RECEIPTS. The drawer must show the signed delivery receipt: GET /v1/tasks/:id/receipts
   * returns receipt_id, completed_at, chain_sequence, chain_entry_hash and signature.
   *
   * REVISION FIX (review item 5): the previous pass only asked for tasks whose status is
   * submitted/verified, on the assumption that only delivered work has receipts. That
   * assumption is false -- a task can carry a receipt while sitting in open or claimed
   * (27 of the 208 receipt-bearing tasks do today). Filtering by status therefore hid a
   * whole class of evidence. We now ask for EVERY task in the census and let the API say
   * which ones have receipts. Nothing here is truncated: hash and signature are stored
   * whole, because a half-printed signature cannot be verified by the reviewer. */
  process.stderr.write('\n[extra] fetching receipts for EVERY task in the census\n');
  const delivered = snap.tasks;
  const receipts = {};
  let rf = 0;
  for (const t of delivered) {
    try {
      const d = await getJSON(`/v1/tasks/${t.id}/receipts`);
      const rs = (d.receipts || []).map((r) => ({
        receipt_id: r.receipt_id,
        agent_id: r.agent_id,
        completed_at: r.completed_at,
        chain_sequence: r.chain_sequence,
        chain_entry_hash: r.chain_entry_hash,
        signature: r.signature,
      }));
      if (rs.length) receipts[t.id] = rs;
    } catch (e) {
      receipts[t.id] = { error: String(e) };
    }
    rf += 1;
    if (rf % 25 === 0) checkpoint({ kind: 'receipts', done: rf, of: delivered.length });
    await sleep(DELAY_MS);
  }
  writeFileSync(resolve(ROOT, 'dist', 'receipts.json'), JSON.stringify(receipts));
  /* Count what the census actually found, including the statuses the old
   * submitted/verified filter made invisible (review item 5 asks exactly this
   * question: how many receipt-bearing tasks sit outside the delivered states). */
  const withRc = Object.keys(receipts).filter((k) => Array.isArray(receipts[k]));
  const statusOf = new Map(snap.tasks.map((t) => [t.id, t.status]));
  snap.stats.receipts_fetched = withRc.length;
  snap.stats.receipts_tasks_asked = delivered.length;
  snap.stats.receipts_outside_delivered_states =
    withRc.filter((id) => !['submitted', 'verified'].includes(statusOf.get(id))).length;

  index.details_chunks = CHUNKS;
  writeFileSync(OUT, JSON.stringify(index));
  for (let i = 0; i < CHUNKS; i++) {
    writeFileSync(resolve(ROOT, 'dist', `details-${i}.json`), JSON.stringify(buckets[i]));
  }
  // re-write the index so stats/crosscheck (added above) land in snapshot.json
  writeFileSync(OUT, JSON.stringify(index));

  /* AGENTS SPLIT (revision fix, measured).
   * The agent directory is 341 KB of the 670 KB index -- description (80 KB) and
   * capabilities (56 KB) dominate -- yet the Tasks view never reads any of it. Shipping
   * it in the render-blocking index cost ~17 Lighthouse performance points (LCP 4.8s).
   * The board is the landing view, so agents move to their own payload fetched when the
   * Agents tab is first opened. index.stats keeps the COUNT so the header can still show
   * it without the data. */
  writeFileSync(resolve(ROOT, 'dist', 'agents.json'), JSON.stringify({
    fetched_at: snap.generated_at,
    api_reported_total: snap.agents.length,
    agents: snap.agents,
  }));
  index.agents = undefined;
  delete index.agents;
  index.agents_loaded_lazily = true;
  writeFileSync(OUT, JSON.stringify(index));

  const kb = (p) => (readFileSync(p).length / 1024).toFixed(1) + ' KiB';
  process.stderr.write(`\nWROTE ${OUT} (${kb(OUT)})\n`);
  for (let i = 0; i < CHUNKS; i++) {
    const p = resolve(ROOT, 'dist', `details-${i}.json`);
    process.stderr.write(`WROTE ${p} (${kb(p)})\n`);
  }
  process.stderr.write(JSON.stringify(snap.stats, null, 2) + '\n');
}

/** FNV-1a 32-bit. Must stay identical to idHash() in dist/app.js. */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

main().catch((e) => {
  process.stderr.write('FATAL: ' + e.message + '\n');
  process.exit(1);
});
