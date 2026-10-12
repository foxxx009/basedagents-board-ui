/* view-shots.mjs — capture the drawer, payments and agents views for the delivery record.
 * Usage: node tools/view-shots.mjs
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = join(ROOT, 'runs');
mkdirSync(RUNS, { recursive: true });
const EXE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const proc = spawn(EXE, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + join(ROOT, '.chrome-views'), '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; const t = setTimeout(() => rej(new Error('x')), 30000); proc.stderr.on('data', (d) => { b += d; const m = b.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); res(m[0]); } }); });
const ws = new WebSocket(wsUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}, s) => new Promise((res, rej) => { const i = ++id; pend.set(i, (x) => (x.error ? rej(new Error(x.error.message)) : res(x.result))); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable');
const ev = async (e) => { const r = await S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
const shot = async (name) => { const s = await S('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(RUNS, name), Buffer.from(s.data, 'base64')); };

await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: 'http://127.0.0.1:8099/' });
await new Promise((r) => setTimeout(r, 1800));

// open the drawer on a task that actually settled, so the chain links are populated
await ev(`(() => {
  const btns = [...document.querySelectorAll('#task-list .t-btn')];
  const i = btns.findIndex(b => b.closest('.task').querySelector('.settled'));
  (btns[i === -1 ? 0 : i]).click();
})()`);
await new Promise((r) => setTimeout(r, 900));
await shot('shot-drawer.png');
console.log('drawer chain links:', await ev(`document.querySelectorAll('#d-chain a').length`));

await ev(`document.getElementById('d-close').click()`);
await ev(`document.querySelector('[data-view="payments"]').click()`);
await new Promise((r) => setTimeout(r, 500));
await shot('shot-payments.png');
console.log('payment rows:', await ev(`document.querySelectorAll('#pay-rows tr').length`));

await ev(`document.querySelector('[data-view="agents"]').click()`);
await new Promise((r) => setTimeout(r, 500));
await shot('shot-agents.png');
console.log('agent cards:', await ev(`document.querySelectorAll('#agent-list .agent').length`));

// filter interaction proof: search + bounty filter
await ev(`document.querySelector('[data-view="board"]').click()`);
await ev(`(() => { const q=document.getElementById('q'); q.value='revenue guard'; q.dispatchEvent(new Event('input')); })()`);
await new Promise((r) => setTimeout(r, 400));
console.log('search "revenue guard" ->', await ev(`document.getElementById('count').textContent`));
await shot('shot-search.png');

try { ws.close(); } catch { /* ignore */ }
proc.kill();
process.exit(0);
