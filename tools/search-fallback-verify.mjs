/* search-fallback-verify.mjs — runtime proof for review blocking item 2.
 *
 * Until details-*.json arrive, the visible list must show ONLY metadata matches.
 * The old code fell through to `return true` while the chunks were in flight, so
 * any query — even one matching nothing — listed all 364 rows. This harness:
 *   1. loads the board and HOLDS every details-*.json request (Fetch domain),
 *   2. types a query that matches nothing ("zzzz-no-such-token") -> 0 rows,
 *   3. types a query that matches only metadata (a category name) -> >0 rows,
 *   4. releases the held chunks, waits for the full-text index,
 *   5. repeats both queries — still 0 for the nonsense one, and the union
 *      (metadata OR full text) holds.
 * Exits non-zero on any failure.
 */
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = join(ROOT, 'runs');
mkdirSync(RUNS, { recursive: true });
const EXE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!EXE) { console.error('NO_BROWSER'); process.exit(3); }

const DEBUG_PORT = 9600 + Math.floor(Math.random() * 300);
const proc = spawn(EXE, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'ba-ui-search-')),
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });
const sleep0 = (ms) => new Promise((r) => setTimeout(r, ms));
const wsUrl = await new Promise(async (res, rej) => {
  for (let i = 0; i < 60; i++) {
    await sleep0(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return res(page.webSocketDebuggerUrl);
    } catch {}
  }
  rej(new Error('devtools did not come up on port ' + DEBUG_PORT));
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
const pausedQueue = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Fetch.requestPaused') { pausedQueue.push(m.params); return; }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable'); await S('Fetch.enable');

// Hold (never fail) every details-*.json until released; pass everything else through.
// After releaseAll flips, chunk requests are let through immediately — otherwise the
// resumed loadFullText() loop's NEXT chunk fetch gets held again and never completes.
const held = [];
let releaseAll = false;
async function pumpPaused() {
  while (pausedQueue.length) {
    const p = pausedQueue.shift();
    if (!releaseAll && /details-\d+\.json/.test(p.request.url)) {
      held.push({ requestId: p.requestId, url: p.request.url });
    } else {
      S('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    }
  }
}
setInterval(pumpPaused, 100).unref();

const evalx = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};
const typeQuery = async (q) => {
  await evalx(`(() => {
    const i = document.querySelector('#q');
    i.value = ${JSON.stringify(q)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep0(120);
};
const rowCount = () => evalx(`document.querySelectorAll('#task-list .task').length`);
const countText = () => evalx(`document.querySelector('#count').textContent`);

await S('Page.navigate', { url: 'http://127.0.0.1:8099/' });
await new Promise(async (res) => {
  for (let i = 0; i < 80; i++) {
    await sleep0(250);
    try { if (await evalx(`document.body.dataset.ready === '1'`)) return res(); } catch {}
  }
  res();
});

const out = { heldChunks: held.length, steps: [] };
const check = (name, pass, detail) => { out.steps.push({ name, pass, detail }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + detail); };

// 1) nonsense query while chunks are held -> must be 0 rows, not 364.
//    Typing triggers loadFullText(), whose fetches are intercepted and held.
await typeQuery('zzzz-no-such-token');
for (let i = 0; i < 20 && held.length < 4; i++) await sleep0(250);
const c1 = await rowCount();
check('nonsense query with chunks held shows 0 rows', c1 === 0, `rows=${c1}, held=${held.length}, count="${await countText()}"`);

// 2) metadata-only query while chunks held -> must be > 0
await typeQuery('research');
const c2 = await rowCount();
check('metadata-only query with chunks held still matches', c2 > 0, `rows=${c2}`);

// 3) release chunks, wait for the full-text index to build
releaseAll = true;
for (const h of held) { S('Fetch.continueRequest', { requestId: h.requestId }).catch(() => {}); }
held.length = 0;
await sleep0(2000);

// 4) nonsense query after chunks -> still 0
await typeQuery('zzzz-no-such-token');
const c3 = await rowCount();
check('nonsense query after chunks loaded still 0 rows', c3 === 0, `rows=${c3}`);

// 5) full-text-only query after chunks -> matches rows (union semantics).
//    'qualification' occurs only in task_vr45efhdsoFyNHBpf8Wbu's description —
//    it is in NO metadata field, so a hit here can only come from the chunks.
await typeQuery('qualification');
const c4 = await rowCount();
check('full-text query after chunks matches (union with metadata)', c4 > 0, `rows=${c4}`);

// 6) clear restores everything
await typeQuery('');
const c5 = await rowCount();
check('cleared query restores the full board', c5 === 364, `rows=${c5}`);

out.heldChunks = held.length;

/* --out lets the delivery builder capture this run's report without touching the
 * committed copy, so the tree the delivery pins stays byte-identical. */
const outArg = process.argv.indexOf('--out');
writeFileSync(outArg > -1 ? resolve(process.argv[outArg + 1]) : join(RUNS, 'search-fallback-verify.json'),
  JSON.stringify(out, null, 1));
const failed = out.steps.filter((s) => !s.pass);
console.log(failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED');
proc.kill();
process.exit(failed.length === 0 ? 0 : 1);
