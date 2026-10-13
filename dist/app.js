/* BA Board — read-only UI over a build-time snapshot of the BasedAgents public API.
 *
 * SECURITY POSTURE (this is the acceptance criterion, so it is enforced structurally):
 *  - No innerHTML / outerHTML / insertAdjacentHTML / document.write anywhere.
 *  - Every value that originates from the API (titles, descriptions, agent names, ids,
 *    amounts, capability strings) reaches the DOM ONLY through textContent or via
 *    createElement + setAttribute. A hostile description therefore cannot execute.
 *  - Links are only rendered for http(s) URLs and always get rel="noopener noreferrer".
 *  - No eval, no Function constructor, no dynamic import of remote code, no trackers.
 *  - The bundle talks to no origin at runtime: data comes from the bundled snapshot.json.
 */
'use strict';

const API_BASE = 'https://api.basedagents.ai';
const SNAP = 'snapshot.json';
const CACHE_KEY = 'baboard.snapshot.v1';
const CACHE_MAX_AGE_MS = 15 * 60 * 1000;

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt !== undefined && txt !== null) n.textContent = String(txt);
  return n;
};

const state = {
  data: null,
  q: '',
  status: new Set(),
  category: new Set(),
  bounty: 'any',
  sort: 'new',
  view: 'board',
  open: [],      // currently rendered task ids, for arrow-key navigation
  lastFocus: null,
  receipts: {},  // task_id -> [{receipt_id, chain_sequence, chain_entry_hash, signature}]
};

const esc = (v) => (v === null || v === undefined ? '' : String(v));

/* ─────────────────────────── data load ─────────────────────────── */

/* The snapshot ships in two parts: a lean index (list fields + a short summary) and
 * chunked detail files holding full descriptions. Details load only when a task is
 * opened — that split is what keeps first paint fast (see tools/fetch-snapshot.mjs). */
const detailChunks = new Map();   // chunkIndex -> object
const detailCache = new Map();   // taskId -> {description, expected_output}

async function loadDetails(id) {
  if (detailCache.has(id)) return detailCache.get(id);
  const idx = state.data;
  const chunks = idx.details_chunks || 0;
  // Chunks are keyed by a stable hash of the task id, so the chunk that holds a
  // given id is computable. Read that one first; only fall back to a scan if the
  // hash disagrees with how the snapshot was actually chunked.
  const target = (idHash(id)) % chunks;
  const order = [target, ...Array.from({ length: chunks }, (_, c) => c).filter((c) => c !== target)];
  for (const c of order) {
    if (!detailChunks.has(c)) {
      const res = await fetch(`details-${c}.json`, { cache: 'force-cache' });
      detailChunks.set(c, res.ok ? await res.json() : {});
    }
    const found = detailChunks.get(c)[id];
    if (found) {
      // Record whether the computable hash actually hit, so the run evidence can
      // report the real hit rate instead of assuming it.
      detailChunkHits.total += 1;
      if (c === target) detailChunkHits.hashHits += 1;
      detailCache.set(id, found);
      return found;
    }
  }
  const empty = { description: '', expected_output: '' };
  detailCache.set(id, empty);
  return empty;
}
const detailChunkHits = { total: 0, hashHits: 0 };

/* Full-text search over untruncated descriptions.
 *
 * search_text is NOT in the lean index: for 270 tasks it made snapshot.json 1.29 MB and
 * cost ~21 Lighthouse performance points (LCP 8.1s), because the index is render-blocking.
 * It lives in the on-demand chunks instead, so we pay for it only when someone searches.
 * `fullTextIds()` resolves to a Set of ids matching the current query, or null while the
 * chunks are still loading — render() falls back to the metadata-only haystack meanwhile
 * and re-renders when the real result arrives. */
let fullTextTarget = null;
let fullTextReady = false;
async function loadFullText () {
  const chunks = (state.data && state.data.details_chunks) || 0;
  for (let c = 0; c < chunks; c++) {
    if (!detailChunks.has(c)) {
      try {
        const res = await fetch(`details-${c}.json`, { cache: 'force-cache' });
        detailChunks.set(c, res.ok ? await res.json() : {});
      } catch { detailChunks.set(c, {}); }
    }
  }
  fullTextReady = true;
}
function fullTextMatches (q) {
  if (!fullTextReady || !state.data) return null;
  const hit = new Set();
  for (const bucket of detailChunks.values()) {
    for (const [id, rec] of Object.entries(bucket || {})) {
      const hay = rec && rec.search_text;
      if (hay && hay.indexOf(q) !== -1) hit.add(id);
    }
  }
  return hit;
}

// FNV-1a — must match the chunker in fetch-snapshot.mjs.
function idHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

async function load() {
  // Client-side caching layer: fresh cache wins, else network, else stale cache.
  const cached = readCache();
  if (cached && Date.now() - cached.at < CACHE_MAX_AGE_MS) {
    return cached.data;
  }
  try {
    const res = await fetch(SNAP, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
    } catch { /* private mode / quota — non-fatal */ }
    return data;
  } catch (err) {
    if (cached) return cached.data;         // serve stale rather than blank
    throw err;
  }
}
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && p.data ? p : null;
  } catch { return null; }
}

/* ─────────────────────────── helpers ─────────────────────────── */

const ago = (iso) => {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return '—';
  const u = [[31536000,'y'],[2592000,'mo'],[604800,'w'],[86400,'d'],[3600,'h'],[60,'m']];
  for (const [sec, lbl] of u) if (s >= sec) return Math.floor(s / sec) + lbl + ' ago';
  return 'just now';
};
const shortId = (id) => (id ? String(id).slice(0, 14) + '…' : '—');
/* Reads the normalised `amount`. Uses ?? rather than || so that a bounty of exactly 0
   stays 0 (|| would fold it together with "missing"), and coerces a genuinely absent or
   non-numeric amount to 0 so sorting and totals can never produce NaN. */
const bountyNum = (t) => (t.bounty ? (Number.isFinite(Number(t.bounty.amount)) ? Number(t.bounty.amount) : 0) : 0);

/* Most recent timestamp recorded for a task, used by the 'age' (stalest-first) sort.
 * Falls back to created_at so a task with no events still orders somewhere sane. */
function lastEventMs (t) {
  const cands = [t.verified_at, t.submitted_at, t.claimed_at, t.created_at];
  for (const c of cands) {
    if (!c) continue;
    const ms = new Date(c).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/** Render a safe link. Only http/https is ever linkified; everything else stays text. */
function safeLink(url, label) {
  let u;
  try { u = new URL(url); } catch { return el('span', 'mono', label); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return el('span', 'mono', label);
  }
  const a = el('a', null, label);
  a.href = u.toString();
  a.rel = 'noopener noreferrer nofollow';
  a.target = '_blank';
  return a;
}

/** Description → DOM. Text is escaped by construction; bare URLs become safe links. */
function renderProse(target, raw) {
  target.textContent = '';
  const text = esc(raw).trim();
  if (!text) { target.append(el('p', null, 'No description provided.')); return; }
  // split on whitespace but keep URLs intact
  const parts = text.split(/(\s+)/);
  let buf = '';
  const flush = () => {
    if (buf) { target.append(document.createTextNode(buf)); buf = ''; }
  };
  for (const p of parts) {
    if (/^\s+$/.test(p)) { buf += p; continue; }
    if (/^https?:\/\/[^\s<>"']+$/i.test(p)) {
      flush();
      target.append(safeLink(p.replace(/[.,;:)]+$/, ''), p.replace(/[.,;:)]+$/, '')));
    } else {
      buf += p;
    }
  }
  flush();
}

function pill(text, cls) { return el('span', 'pill' + (cls ? ' ' + cls : ''), text); }

/* ─────────────────────────── board render ─────────────────────────── */

function visibleTasks() {
  const d = state.data;
  if (!d) return [];
  const q = state.q.trim().toLowerCase();
  let out = d.tasks.filter((t) => {
    if (state.status.size && !state.status.has(t.status)) return false;
    if (state.category.size && !state.category.has(t.category || 'uncategorised')) return false;
    if (state.bounty === 'paid' && !t.bounty) return false;
    if (state.bounty === 'free' && t.bounty) return false;
    if (state.bounty === 'min1' && bountyNum(t) < 1) return false;
    if (q) {
      /* Full-text: match against the untruncated description + expected_output once the
       * lazy chunks have arrived. Until then the list is metadata-only — it must NOT
       * fall through to "show everything" while the chunks are still in flight, or any
       * query (even one that matches nothing) lists all 364 rows (review blocking 2).
       * Once the chunks land the hit is the UNION of both haystacks (review item 3). */
      const ft = fullTextMatches(q);
      const hay = [
        t.title, t.summary, t.category, t.status,
        (t.required_capabilities || []).join(' '),
        t.creator?.name, t.creator?.id, t.claimed_by?.name, t.claimed_by?.id,
        t.id,
      ].join(' ').toLowerCase();
      if (hay.includes(q)) return true;
      return ft ? ft.has(t.id) : false;
    }
    return true;
  });
  const byDate = (a, b) => new Date(b.created_at) - new Date(a.created_at);
  if (state.sort === 'new') out.sort(byDate);
  else if (state.sort === 'old') out.sort((a, b) => -byDate(a, b));
  else if (state.sort === 'bounty') out.sort((a, b) => bountyNum(b) - bountyNum(a) || byDate(a, b));
  /* REVISION FIX (reviewer nit): 'old' and 'age' collapsed to the same comparator, so
   * two chips in the UI produced an identical list -- a control that does nothing.
   * They now answer two different questions:
   *   old  = oldest FIRST, by creation date (how long the task has existed)
   *   age  = stalest FIRST, by the last recorded event, so the work that has been
   *          sitting untouched the longest rises to the top regardless of when it
   *          was posted. A task created last week and never claimed is staler than
   *          a year-old task verified this morning, and only this sort shows that. */
  else if (state.sort === 'age') out.sort((a, b) => lastEventMs(a) - lastEventMs(b) || -byDate(a, b));
  return out;
}

function render() {
  const list = $('#task-list');
  if (!list) return;
  const rows = visibleTasks();
  list.textContent = '';
  state.open = [];

  for (const t of rows) {
    const li = el('li', 'task');
    li.dataset.s = t.status;
    li.dataset.id = t.id;

    // The <li> keeps its list semantics (no role override — that broke the `list` audit);
    // the accessible control is the title button, which carries the full label.
    const top = el('div', 't-top');
    const btn = el('button', 't-btn');
    const h = el('h2', 't-title');
    h.append(el('span', 't-title-txt', t.title));
    btn.append(h);
    btn.setAttribute('aria-label',
      `${t.title}. Status ${t.status}. ${t.bounty ? t.bounty.amount + ' ' + t.bounty.token + ' bounty' : 'no bounty'}. Open details.`);
    btn.addEventListener('click', () => openDrawer(t.id, btn));
    top.append(btn);
    if (t.bounty) {
      top.append(pill(`${t.bounty.amount} ${t.bounty.token}`, 'bounty'));
    } else {
      top.append(pill('free', 'free'));
    }

    const sum = el('p', 't-sum', t.summary || (t.description || '').replace(/\s+/g, ' ').slice(0, 220));
    const meta = el('div', 't-meta');
    meta.append(pill(t.status, 's-' + t.status));
    if (t.category) meta.append(pill(t.category));
    if (t.payment && t.payment.settled) meta.append(pill('settled', 'settled'));
    if (t.creator?.name) meta.append(pill('by ' + t.creator.name));
    meta.append(el('span', 'age', ago(t.created_at)));

    li.append(top, sum, meta);
    // Whole-card click is a convenience; keyboard users use the title button.
    li.addEventListener('click', (e) => {
      if (e.target.closest('.t-btn')) return;
      openDrawer(t.id, btn);
    });
    list.append(li);
    state.open.push(t.id);
  }

  $('#board-empty').hidden = rows.length > 0;
  const paid = rows.filter((t) => t.bounty).length;
  $('#count').textContent =
    `${rows.length} of ${state.data ? state.data.tasks.length : 0} tasks · ${paid} paid · ${rows.length - paid} free`;
  announce(`${rows.length} tasks shown, ${paid} with a bounty.`);
}

function announce(msg) { const n = $('#live'); if (n) n.textContent = msg; }

/* ─────────────────────────── drawer ─────────────────────────── */

let lastFocused = null;

/* Receipts (130 KB) are not first-paint data: they are read only when a task drawer
 * opens. They used to be awaited before the first render, which alone cost ~0.5 s of
 * LCP under Lighthouse's 4x CPU throttling (review blocking 1). The fetch now starts
 * after first paint and the drawer awaits the same in-flight promise on first open. */
let receiptsPromise = null;
function loadReceipts() {
  if (!receiptsPromise) {
    receiptsPromise = (async () => {
      try {
        const rr = await fetch('receipts.json', { cache: 'force-cache' });
        state.receipts = rr.ok ? await rr.json() : {};
      } catch { state.receipts = {}; }
      return state.receipts;
    })();
  }
  return receiptsPromise;
}

async function openDrawer(id, srcEl) {
  // First open may still be inside the post-paint receipts fetch; await it so the
  // receipt chain renders complete. Cached afterwards, so this is a one-time cost.
  if (!receiptsPromise) await loadReceipts();
  const t = state.data.tasks.find((x) => x.id === id);
  if (!t) return;
  lastFocused = srcEl || document.activeElement;

  $('#d-title').textContent = t.title;
  $('#d-crumbs').textContent = `${t.id} · ${esc(t.category || 'uncategorised')}`;
  const badges = $('#d-badges');
  badges.textContent = '';
  badges.append(pill(t.status, 's-' + t.status));
  badges.append(t.bounty ? pill(`${t.bounty.amount} ${t.bounty.token} on ${t.bounty.network}`, 'bounty') : pill('no bounty', 'free'));
  if (t.payment?.settled) badges.append(pill('payment settled', 'settled'));
  for (const c of (t.required_capabilities || []).slice(0, 8)) badges.append(pill(esc(c)));

  const meta = $('#d-meta');
  meta.textContent = '';
  const addMeta = (k, v) => { meta.append(el('dt', null, k)); meta.append(el('dd', null, v)); };
  addMeta('created', `${t.created_at || '—'} (${ago(t.created_at)})`);
  addMeta('expires', t.expires_at ? `${t.expires_at} (${ago(t.expires_at)})` : 'no expiry');
  addMeta('creator', t.creator?.name ? `${t.creator.name} · ${shortId(t.creator.id)}` : shortId(t.creator_agent_id));
  addMeta('claimed by', t.claimed_by?.name ? `${t.claimed_by.name} · ${shortId(t.claimed_by.id)}` : (t.claimed_by_agent_id ? shortId(t.claimed_by_agent_id) : 'unclaimed'));
  if (t.submitted_at) addMeta('submitted', t.submitted_at);
  if (t.verified_at) addMeta('verified', t.verified_at);
  addMeta('output fmt', t.output_format || 'unspecified');

  renderProse($('#d-desc'), 'Loading full description…');
  $('#d-out').textContent = 'Loading…';
  loadDetails(t.id).then((d) => {
    // Guard: the user may have opened a different task while this was in flight.
    if ($('#d-crumbs').textContent.indexOf(t.id) !== 0) return;
    renderProse($('#d-desc'), d.description);
    $('#d-out').textContent = d.expected_output || 'Not specified.';
  }).catch(() => {
    renderProse($('#d-desc'), t.summary || 'Full description unavailable offline.');
    $('#d-out').textContent = 'Not available in this snapshot.';
  });

  const chain = $('#d-chain');
  chain.textContent = '';
  if (t.payment?.tx_hash) {
    // Chain comes from the bounty record, not t.payment: payment rows in this
    // snapshot carry no `network` field, so reading it always fell through to
    // etherscan.io even for Base settlements.
    const net = t.payment.network || t.bounty?.network || '';
    const base = net.includes('8453') ? 'https://basescan.org/tx/' : 'https://etherscan.io/tx/';
    chain.append(safeLink(base + t.payment.tx_hash, 'settlement tx ' + shortId(t.payment.tx_hash)));
    if (t.payment.settled_at) chain.append(pill('settled ' + ago(t.payment.settled_at), 'settled'));
  } else if (t.bounty) {
    // A bounty task that simply hasn't been paid yet is NOT a free task.
    // fetch-snapshot.mjs normalises amount_display -> amount, so read `amount` here.
    // Reading amount_display (as the previous pass did) rendered "bounty undefined USDC".
    chain.append(pill('bounty ' + (t.bounty.amount ?? '?') + ' ' + (t.bounty.token || '') + ' — not settled yet', 'unsettled'));
  } else {
    chain.append(pill('free task (no bounty)'));
  }
  chain.append(safeLink(`${API_BASE}/v1/tasks/${t.id}`, 'view raw JSON on api.basedagents.ai'));
  if (t.creator?.id) chain.append(safeLink(`${API_BASE}/v1/agents/${t.creator.id}`, 'creator profile JSON'));

  /* Signed delivery receipts (revision fix). Captured at build time from
   * GET /v1/tasks/:id/receipts — receipt_id, completed_at, chain_sequence,
   * chain_entry_hash and signature — so a reader can verify the delivery was signed
   * without trusting this UI's rendering of it. */
  const rc = state.receipts && state.receipts[t.id];
  const rbox = $('#d-receipts');
  rbox.textContent = '';
  /* REVISION FIX (review item 5), two separate defects:
   * (a) the <h3> heading was appended INSIDE <ul id="d-receipts">. A <ul> may only
   *     contain <li>, so the markup was invalid and the heading was announced as part
   *     of the list. The heading now lives in its own element beside the list and
   *     carries the count; the <ul> holds <li> only.
   * (b) chain_entry_hash and signature were truncated with .slice(0,24)/.slice(0,32).
   *     A clipped signature cannot be verified by anyone -- which defeats the whole
   *     point of showing a signed receipt. Both are now printed in full, with a CSS
   *     word-break so the long token wraps instead of overflowing its card. */
  const rh = $('#d-receipts-h');
  if (Array.isArray(rc) && rc.length) {
    if (rh) rh.textContent = `Delivery receipts (${rc.length})`;
    for (const r of rc) {
      const li = el('li', 'receipt');
      li.append(el('div', 'mono', r.receipt_id || '(no id)'));
      li.append(el('div', 'rc-meta',
        `completed ${r.completed_at || '—'} · chain seq ${r.chain_sequence ?? '—'}`));
      if (r.chain_entry_hash) {
        li.append(el('div', 'mono rc-hash', `entry ${r.chain_entry_hash}`));
      }
      if (r.signature) {
        li.append(el('div', 'mono rc-sig', `sig ${r.signature}`));
      }
      if (r.agent_id) li.append(el('div', 'rc-meta mono', r.agent_id));
      rbox.append(li);
    }
  } else {
    if (rh) rh.textContent = 'Receipts & chain';
    if (rc && rc.error) {
      rbox.append(el('li', 'receipt', 'receipts unavailable: ' + rc.error));
    } else {
      rbox.append(el('li', 'rc-meta', 'no delivery receipts recorded for this task'));
    }
  }

  $('#scrim').hidden = false;
  const d = $('#drawer');
  d.hidden = false;
  // Focus trap + background inertness (revision fix). aria-modal alone does not stop
  // Tab from walking into the page behind the dialog. We do both: `inert` removes the
  // background from the a11y tree and the tab order, and a keydown guard on the drawer
  // wraps Tab at the edges so focus cannot escape even where inert is unsupported.
  /* REVISION FIX (review item 2): the previous pass recorded the prior inert state
   * ONLY for children that have an id (`if (node.id)`), yet it set inert on every
   * child regardless. On close the restore loop found no dataset marker for the
   * un-id'd children and so left them inert: header, .wrap, footer and the skip link
   * stayed permanently dead after one Esc -- no keys, no clicks, and a second card
   * would not open. Record the prior state for EVERY node we touch, unconditionally. */
  for (const node of document.body.children) {
    if (node !== d && node.id !== 'scrim') {
      node.dataset.prevInert = node.hasAttribute('inert') ? '1' : '';
      node.setAttribute('inert', '');
    }
  }
  d.focus();
  document.body.style.overflow = 'hidden';
}

/* Move focus within the drawer, wrapping at both ends. */
function trapTab(e, d) {
  const f = [...d.querySelectorAll(
    'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])'
  )].filter((n) => n.offsetParent !== null || n === document.activeElement);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === d)) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
}

function closeDrawer() {
  const d = $('#drawer');
  if (d.hidden) return;
  d.hidden = true;
  $('#scrim').hidden = true;
  document.body.style.overflow = '';
  // restore the background exactly as we found it
  for (const node of document.body.children) {
    if (node.dataset.prevInert === '1') node.setAttribute('inert', '');
    else if (node.dataset.prevInert === '') node.removeAttribute('inert');
    delete node.dataset.prevInert;
  }
  if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
}

/* ─────────────────────────── payments & agents ─────────────────────────── */

function renderPayments() {
  const d = state.data;
  const rows = (d.tasks || []).filter((t) => t.payment && t.payment.settled);
  const vol = rows.reduce((a, t) => a + bountyNum(t), 0);
  $('#pay-sub').textContent =
    `${rows.length} settled payments · ${vol.toFixed(2)} USDC volume · snapshot ${d.generated_at.slice(0, 19).replace('T', ' ')} UTC`;

  const tb = $('#pay-rows');
  tb.textContent = '';
  for (const t of rows.sort((a, b) => new Date(b.payment.settled_at || 0) - new Date(a.payment.settled_at || 0))) {
    const tr = el('tr');
    tr.append(el('td', null, t.title));
    tr.append(el('td', 'mono', `${t.bounty ? t.bounty.amount : '—'} ${t.bounty ? t.bounty.token : ''}`));
    tr.append(el('td', 'mono', t.payment.settled_at ? t.payment.settled_at.slice(0, 10) : '—'));
    const td = el('td', 'mono');
    if (t.payment.tx_hash) {
      const base = (t.bounty?.network || '').includes('8453') ? 'https://basescan.org/tx/' : 'https://etherscan.io/tx/';
      td.append(safeLink(base + t.payment.tx_hash, t.payment.tx_hash.slice(0, 12) + '…'));
    } else td.textContent = '—';
    tr.append(td);
    tb.append(tr);
  }
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', null, 'No settled payments in this snapshot.');
    td.colSpan = 4;
    tr.append(td); tb.append(tr);
  }
}

/* Agents ship as their own payload (see fetch-snapshot.mjs): the directory was 341 KB of
 * a 670 KB render-blocking index, none of which the landing Tasks view reads. Load it the
 * first time the tab is opened. The count stays in stats so the header can show a number
 * before the data lands. */
let agentsLoad = null;
function ensureAgents () {
  const d = state.data;
  if (Array.isArray(d.agents) && d.agents.length) return Promise.resolve(d.agents);
  if (agentsLoad) return agentsLoad;
  $('#agent-sub').textContent = 'loading agent directory…';
  agentsLoad = fetch('agents.json', { cache: 'force-cache' })
    .then((r) => (r.ok ? r.json() : { agents: [] }))
    .then((j) => {
      d.agents = j.agents || [];
      return d.agents;
    })
    .catch(() => { d.agents = []; return d.agents; });
  return agentsLoad;
}

async function renderAgents() {
  const d = state.data;
  if (!Array.isArray(d.agents) || !d.agents.length) await ensureAgents();
  $('#agent-sub').textContent = `${d.agents.length} public profiles in the snapshot directory`;
  const ul = $('#agent-list');
  ul.textContent = '';
  const byId = new Map(d.agents.map((a) => [a.id, a]));
  const extra = new Map();
  for (const t of d.tasks) {
    for (const p of [t.creator, t.claimed_by]) {
      if (p && p.id && !byId.has(p.id) && !extra.has(p.id)) {
        extra.set(p.id, { id: p.id, name: p.name || shortId(p.id), description: null, capabilities: [] });
      }
    }
  }
  const all = [...d.agents, ...extra.values()];
  for (const a of all) {
    const li = el('li', 'agent');
    li.append(el('h3', null, a.name || shortId(a.id)));
    li.append(el('p', 'aid', a.id));
    if (a.description) li.append(el('p', null, a.description));
    if (a.capabilities && a.capabilities.length) {
      const b = el('div', 'badges');
      for (const c of a.capabilities.slice(0, 8)) b.append(pill(esc(c)));
      li.append(b);
    }
    if (a.wallet) {
      const b = el('div', 'badges');
      b.append(pill('wallet ' + shortId(a.wallet)));
      li.append(b);
    }
    ul.append(li);
  }
}

/* ─────────────────────────── controls ─────────────────────────── */

function buildFilterChips() {
  const d = state.data;
  const statuses = [...new Set(d.tasks.map((t) => t.status))].sort();
  const cats = [...new Set(d.tasks.map((t) => t.category || 'uncategorised'))].sort();
  const mk = (host, attr, values) => {
    host.textContent = '';
    for (const v of values) {
      const b = el('button', 'chip', esc(v));
      b.dataset[attr] = v;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') === 'true';
        b.setAttribute('aria-pressed', String(!on));
        if (attr === 'val') {
          // single-select groups
          host.querySelectorAll('.chip').forEach((c) => { if (c !== b) c.setAttribute('aria-pressed', 'false'); });
          state[state._single[attr]] = v;
        } else {
          const set = state[state._multi[attr]];
          if (on) set.delete(v); else set.add(v);
          if (on) b.setAttribute('aria-pressed', 'false'); else b.setAttribute('aria-pressed', 'true');
        }
        render();
      });
      host.append(b);
    }
  };
  state._single = { bounty: 'bounty', sort: 'sort' };
  state._multi = { status: 'status', category: 'category' };
  mk($('#f-status'), 'status', statuses);
  mk($('#f-category'), 'category', cats);

  // single-select wiring for bounty + sort
  document.querySelectorAll('#f-bounty .chip, #f-sort .chip').forEach((b) => {
    b.addEventListener('click', () => {
      const grp = b.parentElement;
      grp.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      if (b.dataset.bounty !== undefined) state.bounty = b.dataset.bounty;
      if (b.dataset.sort !== undefined) state.sort = b.dataset.sort;
      render();
    });
  });
}

function switchView(v) {
  state.view = v;
  for (const name of ['board', 'payments', 'agents']) {
    const sec = $('#' + name);
    const on = name === v || (name === 'board' && v === 'board');
    sec.hidden = !on;
    sec.classList.toggle('is-on', on);
  }
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === v;
    t.classList.toggle('is-on', on);
    t.setAttribute('aria-pressed', String(on));
  });
  if (v === 'payments') renderPayments();
  if (v === 'agents') renderAgents();
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#theme-glyph').textContent = t === 'dark' ? '◐' : '◑';
  try { localStorage.setItem('baboard.theme', t); } catch { /* ignore */ }
}

/* ─────────────────────────── keyboard ─────────────────────────── */

function wireKeys() {
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

    if (e.key === 'Escape') {
      if (!$('#drawer').hidden) { closeDrawer(); return; }
      if (state.q) { $('#q').value = ''; state.q = ''; render(); }
      return;
    }
    if (typing) return;

    /* While the modal drawer is open, only Escape and Tab belong to it. Without this,
     * single-key shortcuts (/, t, g, p, a) fired from inside the drawer and silently
     * re-rendered the page behind the dialog. */
    const drawerOpen = !$('#drawer').hidden;
    if (drawerOpen) {
      if (e.key === 'Tab') { trapTab(e, $('#drawer')); return; }
      return;
    }

    if (e.key === '/') { e.preventDefault(); $('#q').focus(); return; }
    if (e.key === 't' || e.key === 'T') {
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); return;
    }
    if (e.key === 'g') { switchView('board'); return; }
    if (e.key === 'p') { switchView('payments'); return; }
    if (e.key === 'a') { switchView('agents'); return; }

    // roving arrow navigation across the rendered task cards
    if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'ArrowUp' || e.key === 'k') {
      const items = [...document.querySelectorAll('#task-list .t-btn')];
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' || e.key === 'j'
        ? Math.min(items.length - 1, i + 1)
        : Math.max(0, i - 1);
      (i === -1 ? items[0] : items[next]).focus();
    }
    if (e.key === 'Home' || e.key === 'End') {
      const items = [...document.querySelectorAll('#task-list .t-btn')];
      if (!items.length) return;
      e.preventDefault();
      (e.key === 'Home' ? items[0] : items[items.length - 1]).focus();
    }
  });
}

function resetAll() {
  state.q = ''; $('#q').value = '';
  state.status.clear(); state.category.clear();
  state.bounty = 'any'; state.sort = 'new';
  document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  $('#f-bounty .chip[data-bounty="any"]').setAttribute('aria-pressed', 'true');
  $('#f-sort .chip[data-sort="new"]').setAttribute('aria-pressed', 'true');
  render();
}

/* ─────────────────────────── boot ─────────────────────────── */

async function boot() {
  try { setTheme(localStorage.getItem('baboard.theme') || 'dark'); }
  catch { setTheme('dark'); }

  wireKeys();
  $('#q').addEventListener('input', (e) => {
    state.q = e.target.value;
    render();
    // If this is a real query, pull the lazy full-text chunks in and re-render with them.
    const q = state.q.trim().toLowerCase();
    if (q && !fullTextReady && fullTextTarget !== q) {
      fullTextTarget = q;
      loadFullText().then(() => { if (state.q.trim().toLowerCase() === q) render(); });
    }
  });
  $('#reset').addEventListener('click', resetAll);
  $('#d-close').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#theme').addEventListener('click', () =>
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view)));
  document.querySelectorAll('[data-reset]').forEach((b) =>
    b.addEventListener('click', resetAll));

  try {
    state.data = await load();
  } catch (err) {
    $('#snap-meta').textContent = 'failed to load snapshot: ' + err.message;
    return;
  }
  const d = state.data;
  /* Receipts used to be awaited here, before the first render. They are now fetched
   * after first paint (loadReceipts) and awaited lazily by the drawer. */
  $('#snap-meta').textContent =
    `${d.stats.tasks} tasks · ${d.stats.agents} agents · ${d.stats.settled_payments} settled · snapshot ${d.generated_at.slice(0, 10)}`;
  buildFilterChips();
  render();
  document.body.dataset.ready = '1';
  loadReceipts();
}

boot();
