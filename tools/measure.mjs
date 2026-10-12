/* measure.mjs — report the rendered height of each page region at a given viewport.
 * Used to reserve space for late-injected content (the CLS fix).
 * Usage: node tools/measure.mjs [width] [height]
 */
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!EXE) { console.error('NO_BROWSER'); process.exit(3); }

const proc = spawn(EXE, [
  '--headless=new', '--remote-debugging-port=0',
  '--user-data-dir=' + join(ROOT, '.chrome-measure'),
  '--no-first-run', '--disable-gpu', '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const wsUrl = await new Promise((res, rej) => {
  let b = '';
  const t = setTimeout(() => rej(new Error('no debug url')), 30000);
  proc.stderr.on('data', (d) => {
    b += d.toString();
    const m = b.match(/ws:\/\/[^\s]+/);
    if (m) { clearTimeout(t); res(m[0]); }
  });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id;
  pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable');
const evalx = async (expr) => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};

const W = Number(process.argv[2] || 1440);
const H = Number(process.argv[3] || 900);
await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 500 });
await S('Page.navigate', { url: 'http://127.0.0.1:8099/' });
await new Promise((r) => setTimeout(r, 2000));

const m = await evalx(`(() => {
  const g = (s) => { const e = document.querySelector(s); if (!e) return null;
    const r = e.getBoundingClientRect(); return { h: Math.round(r.height), top: Math.round(r.top + scrollY) }; };
  return {
    ready: document.body.dataset.ready,
    controls: g('.controls'), filterGrid: g('.filter-grid'), resultBar: g('.result-bar'),
    board: g('#board'), count: g('#count'), header: g('.top'),
    chipsStatus: g('#f-status'), chipsCategory: g('#f-category'),
    cards: document.querySelectorAll('#task-list .task').length,
  };
})()`);
console.log(W + 'x' + H, JSON.stringify(m, null, 1));
try { ws.close(); } catch { /* ignore */ }
proc.kill();
process.exit(0);
