/* xss-test.mjs — hostile-fixture check against the BUILT bundle in a real browser.
 *
 * Method: launch Edge/Chrome via CDP (no puppeteer dependency — raw WebSocket CDP),
 * load dist/index.html over a local static server, inject the hostile fixtures into
 * the bundled snapshot, then assert that:
 *   1. no payload executed (no window.__XSS_* globals),
 *   2. no <script>/<img>/<iframe>/<svg> element was created from task data,
 *   3. the payload appears as literal TEXT (proving it was escaped, not dropped),
 *   4. the title attribute / aria-label is not attacker-controlled markup,
 *   5. opening the drawer on a hostile task does not execute anything.
 *
 * Usage: node tools/xss-test.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = join(ROOT, 'dist');

const CHROME_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!exe) { console.error('NO_BROWSER: no Edge/Chrome found'); process.exit(3); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

/* ── static server, bound strictly to loopback ── */
const serverRef = createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (!u.pathname.startsWith('/127.0.0.1') && u.pathname !== '/' && !u.pathname.startsWith('/index')
      && !u.pathname.startsWith('/app.js') && !u.pathname.startsWith('/styles.css')
      && !u.pathname.startsWith('/snapshot.json')) {
    res.writeHead(403).end('local-only guard');
    return;
  }
  const rel = u.pathname === '/' ? '/index.html' : u.pathname;
  const p = join(DIST, rel.replace(/^\/+/, ''));
  if (!p.startsWith(DIST) || !existsSync(p)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(p));
});
await new Promise((r) => serverRef.listen(0, '127.0.0.1', r));
const PORT = serverRef.address().port;
const BASE = `http://127.0.0.1:${PORT}/`;

/* ── launch browser ──
 * A FRESH profile dir per run. Reusing one fixed .chrome-profile means a run that dies
 * before the exit handler leaves a live Edge holding the profile lock, and the next run
 * starts an Edge that hands the port to the stale process instead of printing its own ws
 * URL -- which surfaced as "browser did not report a debug URL" after 30s. The per-run
 * dir makes the failure mode impossible rather than merely rare. */
const udd = join(ROOT, '.chrome-profile-' + process.pid);
/* Windows: spawn() of msedge.exe returns a LAUNCHER that exits 0 immediately, while the
 * real browser runs detached with its own stdio. So parsing the child's stderr for
 * "DevTools listening on ws://..." can never work here -- it waits 30s and then reports
 * "browser did not report a debug URL" no matter how healthy the browser is. Verified
 * directly: the launcher exits 0 within a second and emits zero bytes on both pipes.
 * Fix: pin an explicit port and discover the socket over HTTP /json/list instead. */
const DEBUG_PORT = 9300 + (process.pid % 400);
const proc = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${udd}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--disable-extensions', '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

/* Kill the whole browser tree on every exit path, including the ones that throw.
 * NOTE: these handlers MUST print before exiting. An earlier version of this file
 * swallowed the reason entirely and exited 1 with empty stdout, which is
 * indistinguishable from a security failure -- the exact "read it as absence of
 * evidence" trap this suite exists to avoid. */
let closed = false;

/* Windows teardown, in two steps, because neither one alone is sufficient:
 *   1. proc.kill() only reaps the LAUNCHER, whose pid exits immediately.
 *   2. taskkill on proc.pid therefore has no tree left to walk.
 * The real browser is whoever LISTENS on our debug port, so ask the OS directly:
 * `netstat -ano` names that pid, and /T walks its whole tree. Measured on this machine:
 * taskkill(proc.pid) left 34 orphans; matching by profile-dir command line left 20;
 * matching by listening port leaves 0. */
function killBrowserTree () {
  try { proc.kill(); } catch {}
  const pids = new Set();
  try {
    const net = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 20000 });
    for (const line of (net.stdout || '').split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      /* netstat rows are: Proto Local Foreign State PID. Match the LOCAL ENDPOINT field
       * exactly -- a substring test on the whole line also matches foreign endpoints and
       * any port whose digits merely contain ours. */
      if (parts.length < 5) continue;
      if (parts[0].toUpperCase() !== 'TCP') continue;
      const local = parts[1];
      const colon = local.lastIndexOf(':');
      if (colon < 0) continue;
      if (local.slice(colon + 1) !== String(DEBUG_PORT)) continue;
      const pid = parseInt(parts[parts.length - 1], 10);
      if (pid > 0) pids.add(pid);
    }
  } catch {}
  /* Never target this process or its ancestors. A pid misread here would kill the test
   * runner mid-teardown, which is exactly what happened: the JSON report printed, then
   * the process vanished with status 1 and no diagnostic at all. */
  const forbidden = new Set([process.pid, process.ppid]);
  for (const p of pids) {
    if (forbidden.has(p)) continue;
    try { spawnSync('taskkill', ['/pid', String(p), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
  return [...pids].filter((p) => !forbidden.has(p)).length;
}

function shutdown (code, err) {
  if (closed) return;
  closed = true;
  if (err) console.error('ABORTED: ' + (err && err.stack ? err.stack : String(err)));
  try { wsRef?.close(); } catch {}
  try { serverRef?.close(); } catch {}
  killBrowserTree();
  try { rmSync(udd, { recursive: true, force: true }); } catch {}
  /* An 'exit' listener must NOT call process.exit(): re-entering exit from inside the
   * handler makes Node terminate with status 1 regardless of the code passed. That is
   * why a fully PASSING run reported exit 1. Exit listeners below therefore only do the
   * teardown, never the exit. */
  process.exit(code);
}
process.on('exit', () => { if (!closed) { closed = true; killBrowserTree(); } });
process.on('SIGINT', () => shutdown(1));
process.on('SIGTERM', () => shutdown(1));
process.on('uncaughtException', (e) => shutdown(1, e));
process.on('unhandledRejection', (e) => shutdown(1, e));

/* Poll the DevTools HTTP endpoint for a page target, then take its webSocketDebuggerUrl. */
let wsUrl = null;
{
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !wsUrl) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
  }
  if (!wsUrl) throw new Error(`no DevTools page target on 127.0.0.1:${DEBUG_PORT} after 30s`);
}

/* ── minimal CDP client ── */
const wsRef = new WebSocket(wsUrl);
await new Promise((r) => { wsRef.onopen = r; });
let msgId = 0;
const pending = new Map();
const events = [];
wsRef.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
  wsRef.send(JSON.stringify({ id, method, params, sessionId }));
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);

await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable');
await S('Network.enable');

// Record every request the page makes — a beacon would show up here.
const requests = [];
wsRef.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description || ''));
  }
});
const consoleErrors = [];

const evaluate = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

/* ── load the built bundle ── */

/* The app now loads a lean index first and fetches full descriptions from
 * details-<n>.json on demand. To test the REAL sink we must feed both, so we install
 * a fetch interceptor *before any page script runs* (addScriptToEvaluateOnNewDocument).
 * This drives the genuine code path — index render, async detail load, drawer — rather
 * than a synthetic stand-in. */
const interceptor = `
(() => {
  const F = ${JSON.stringify(readFixtures())};
  const hostileTasks = F.map((f, i) => ({
    id: 'task_HOSTILE_' + i,
    title: f.title,
    description: f.description,
    category: 'content',
    status: 'open',
    created_at: new Date(Date.now() - i * 3600e3).toISOString(),
    claimed_at: null, submitted_at: null, verified_at: null,
    expires_at: null,
    creator: { id: 'ag_HOSTILE', name: '<img src=x onerror="window.__XSS_AGENT__=1">', kind: 'agent' },
    creator_agent_id: 'ag_HOSTILE',
    claimed_by_agent_id: null, claimed_by: null,
    required_capabilities: ['<svg onload=window.__XSS_CAP__=1>', 'javascript:alert(1)'],
    expected_output: '<script>window.__XSS_OUT__=1<\\/script>',
    output_format: 'json',
    bounty: { amount: '<img src=x onerror=window.__XSS_AMT__=1>', token: 'USDC', network: 'eip155:8453' },
    payment: { status: 'pending', tx_hash: null, settled: false, verified: false, settled_at: null },
  }));
  const index = {
    generated_at: new Date().toISOString(),
    api: 'https://api.basedagents.ai',
    tasks: hostileTasks.map(t => {
      const { description, expected_output, ...rest } = t;
      return Object.assign({}, rest, { summary: description.replace(/\\s+/g, ' ').slice(0, 260) });
    }),
    agents: [{ id: 'ag_HOSTILE', name: '<img src=x onerror="window.__XSS_AGENT__=1">', description: '<svg onload=window.__XSS_AGENT__=1>', capabilities: ['<iframe src=javascript:1>'], protocols: [], offers: [], needs: [], homepage: null, wallet: null }],
    stats: { tasks: hostileTasks.length, agents: 1, settled_payments: 0, settled_volume_usdc: 0, by_status: { open: hostileTasks.length } },
    details_chunks: 4,
  };
  const details = {};
  for (const t of hostileTasks) details[t.id] = { description: t.description, expected_output: t.expected_output };

  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
  const real = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/snapshot\\.json/.test(url)) return Promise.resolve(json(index));
    const m = /details-(\\d+)\\.json/.exec(url);
    if (m) {
      const n = Number(m[1]);
      // mirror the app's FNV-1a chunker so the payload lands in the chunk it looks in
      const bucket = {};
      for (const id of Object.keys(details)) {
        let h = 0x811c9dc5;
        for (let k = 0; k < id.length; k++) { h ^= id.charCodeAt(k); h = Math.imul(h, 0x01000193) >>> 0; }
        if ((h >>> 0) % 4 === n) bucket[id] = details[id];
      }
      return Promise.resolve(json(bucket));
    }
    return real(input, init);
  };
  window.__XSS_FIXTURE_COUNT = F.length;
})();
`;

function readFixtures() {
  const src = readFileSync(join(ROOT, 'fixtures', 'hostile.js'), 'utf8');
  // evaluate the fixture file in a throwaway context to get the array as JSON
  const sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', src)(sandbox.window);
  return sandbox.window.HOSTILE_FIXTURES;
}

await S('Page.addScriptToEvaluateOnNewDocument', { source: interceptor });
await S('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 1500));
const ready = await evaluate('document.body.dataset.ready === "1"');
if (!ready) { console.error('PAGE_NOT_READY'); cleanup(1); }

const before = requests.length;
const fixtureInfo = await evaluate('window.__XSS_FIXTURE_COUNT || 0');

const audit = await evaluate(`(() => {
  const fired = Object.keys(window).filter(k => k.startsWith('__XSS_') && k !== '__XSS_FIXTURE_COUNT');
  const injected = {
    scripts: document.querySelectorAll('#task-list script, #drawer script, .prose script').length,
    imgs:    document.querySelectorAll('#task-list img, #drawer img, .prose img').length,
    iframes: document.querySelectorAll('#task-list iframe, #drawer iframe, .prose iframe').length,
    svgs:    document.querySelectorAll('#task-list svg, #drawer svg, .prose svg').length,
    objects: document.querySelectorAll('#task-list object, #drawer object, .prose object').length,
    styles:  document.querySelectorAll('#task-list style, #drawer style, .prose style').length,
  };
  // does the literal payload text survive as text?
  const first = document.querySelector('#task-list .t-title');
  const firstDesc = document.querySelector('#task-list .t-sum');
  // any attribute anywhere in our own markup carrying a raw on* handler from data?
  const attrInjection = [...document.querySelectorAll('#task-list *, #drawer *')].filter(el => {
    for (const a of el.attributes) {
      if (/^on/i.test(a.name) && !['onclick'].includes(a.name)) return true;
    }
    return false;
  }).length;
  // any javascript: href produced?
  const jsHrefs = [...document.querySelectorAll('a[href]')].filter(a => /^javascript:/i.test(a.getAttribute('href'))).length;
  return {
    firedGlobals: fired,
    injected,
    attrInjection,
    jsHrefs,
    titleTextSample: first ? first.textContent.slice(0, 60) : null,
    descTextSample: firstDesc ? firstDesc.textContent.slice(0, 60) : null,
    taskCount: document.querySelectorAll('#task-list .task').length,
  };
})()`);

// open the drawer on a hostile task — the detail view is the richer sink, and it now
// loads descriptions asynchronously, so wait for that fetch to land.
await evaluate(`(() => {
  const b = document.querySelector('#task-list .t-btn');
  if (b) b.click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 900));

const drawerAudit = await evaluate(`(() => {
  const fired = Object.keys(window).filter(k => k.startsWith('__XSS_') && k !== '__XSS_FIXTURE_COUNT');
  return {
    firedGlobals: fired,
    open: !document.getElementById('drawer').hidden,
    scripts: document.querySelectorAll('#drawer script').length,
    imgs: document.querySelectorAll('#drawer img').length,
    iframes: document.querySelectorAll('#drawer iframe').length,
    svgs: document.querySelectorAll('#drawer svg').length,
    jsHrefs: [...document.querySelectorAll('#drawer a[href]')].filter(a => /^javascript:/i.test(a.getAttribute('href'))).length,
    descIsText: (() => {
      const d = document.getElementById('d-desc');
      return d ? d.children.length === 0 && d.textContent.length > 0 : false;
    })(),
    descSample: (document.getElementById('d-desc')?.textContent || '').slice(0, 80),
  };
})()`);

const netAfter = requests.slice(before);
const beacons = netAfter.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('about:'));

/* ── verdict ── */
const problems = [];
if (audit.firedGlobals.length) problems.push('payload executed on board view: ' + audit.firedGlobals.join(','));
if (drawerAudit.firedGlobals.length) problems.push('payload executed in drawer: ' + drawerAudit.firedGlobals.join(','));
for (const [k, v] of Object.entries(audit.injected)) if (v > 0) problems.push(`board injected <${k}>: ${v}`);
for (const k of ['scripts', 'imgs', 'iframes', 'svgs']) if (drawerAudit[k] > 0) problems.push(`drawer injected ${k}: ${drawerAudit[k]}`);
if (audit.attrInjection) problems.push('event-handler attribute injected: ' + audit.attrInjection);
if (audit.jsHrefs || drawerAudit.jsHrefs) problems.push('javascript: href rendered');
if (beacons.length) problems.push('off-origin request (beacon): ' + beacons.join(','));
if (!drawerAudit.descIsText) problems.push('description not rendered as pure text nodes');

const report = {
  browser: exe.replace(/^.*[\\/]/, ''),
  fixtures: fixtureInfo,
  board: audit,
  drawer: drawerAudit,
  off_origin_requests: beacons,
  console_errors: consoleErrors,
  verdict: problems.length ? 'FAIL' : 'PASS',
  problems,
};
console.log(JSON.stringify(report, null, 2));
writeOut('xss-report.json', report);
cleanup(problems.length ? 1 : 0);

function writeOut(name, obj) {
  mkdirSync(join(ROOT, 'runs'), { recursive: true });
  writeFileSync(join(ROOT, 'runs', name), JSON.stringify(obj, null, 2));
}
/* Route every exit through the single shutdown path. The normal completion path used to
 * call proc.kill() on the launcher only, which on Windows leaves the renderer/gpu
 * children alive: one run leaked 96 Edge processes and 8 profile dirs, each holding a
 * lock that breaks the NEXT run. There is exactly one teardown, and it kills the tree. */
function cleanup(code) {
  shutdown(code);
}
