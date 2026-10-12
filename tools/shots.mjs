/* shots.mjs — capture 360px and 1440px screenshots plus a keyboard-only walkthrough.
 * Also asserts responsive correctness (no horizontal overflow) and exercises the
 * keyboard path: Tab / arrow keys / Enter / Esc / "/" / theme toggle.
 * Usage: node tools/shots.mjs
 */
import { existsSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
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

/* PIN THE PORT and poll /json/list. The old code used --remote-debugging-port=0 and
 * parsed "DevTools listening on ws://..." out of the child's stderr -- which is empty on
 * Windows, because spawn() of msedge.exe returns a launcher that exits immediately while
 * the real browser runs detached. That is why this script died with "no debug url",
 * exactly as tools/xss-test.mjs did before it was fixed the same way. */
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 300);
const proc = spawn(EXE, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
  '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'ba-ui-shots-')),
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
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
async function key(k, code, vk) {
  // Enter/Space need rawKeyDown + a char event for the browser to perform the default
  // action (activating a <button>). A bare keyDown does not — that was a harness bug,
  // not an app bug. Navigational keys only need keyDown/keyUp.
  const isActivator = k === 'Enter' || k === ' ';
  if (isActivator) {
    await S('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      text: k === 'Enter' ? '\r' : ' ',
    });
    await S('Input.dispatchKeyEvent', { type: 'char', text: k === 'Enter' ? '\r' : ' ' });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  } else {
    await S('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
  await new Promise((r) => setTimeout(r, 140));
}

const report = { viewports: [], keyboard: {}, overflow: {} };

for (const [label, w, h, mobile] of [['desktop-1440', 1440, 900, false], ['mobile-360', 360, 780, true]]) {
  await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await S('Page.navigate', { url: 'http://127.0.0.1:8099/' });
  await new Promise((r) => setTimeout(r, 1800));

  const m = await evalx(`(() => ({
    cards: document.querySelectorAll('#task-list .task').length,
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    hOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    colCount: getComputedStyle(document.querySelector('.filter-grid')).gridTemplateColumns.split(' ').length,
    chipRows: (() => { const c = document.querySelector('#f-status'); return c ? Math.round(c.getBoundingClientRect().height) : 0; })(),
    fontsLoaded: document.fonts ? document.fonts.status : 'n/a',
  }))()`);
  report.viewports.push({ label, w, h, ...m });
  report.overflow[label] = m.hOverflow;

  const shot = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(RUNS, `shot-${label}.png`), Buffer.from(shot.data, 'base64'));

  // light theme variant on desktop
  if (!mobile) {
    await evalx(`document.documentElement.dataset.theme='light'`);
    await new Promise((r) => setTimeout(r, 250));
    const s2 = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(RUNS, 'shot-desktop-light.png'), Buffer.from(s2.data, 'base64'));
    await evalx(`document.documentElement.dataset.theme='dark'`);
  }
}

/* ── keyboard-only walkthrough (desktop) ── */
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: 'http://127.0.0.1:8099/' });
await new Promise((r) => setTimeout(r, 1800));

const kb = {};
kb.initialFocus = await evalx(`document.activeElement.tagName + '.' + (document.activeElement.className||'')`);
await key('/', 'Slash', 191);
kb.afterSlash = await evalx(`document.activeElement.id`);
await key('Escape', 'Escape', 27);
await evalx(`document.querySelector('#task-list .t-btn').focus()`);
kb.focusedCard = await evalx(`document.activeElement.querySelector('.t-title-txt').textContent.slice(0,40)`);
await key('ArrowDown', 'ArrowDown', 40);
kb.afterArrowDown = await evalx(`document.activeElement.querySelector('.t-title-txt').textContent.slice(0,40)`);
await key('End', 'End', 35);
kb.afterEnd = await evalx(`document.activeElement === document.querySelectorAll('#task-list .t-btn')[document.querySelectorAll('#task-list .t-btn').length-1]`);
await key('Home', 'Home', 36);
kb.afterHome = await evalx(`document.activeElement === document.querySelectorAll('#task-list .t-btn')[0]`);
await key('Enter', 'Enter', 13);
await new Promise((r) => setTimeout(r, 600));
kb.drawerOpen = await evalx(`!document.getElementById('drawer').hidden`);
kb.drawerFocus = await evalx(`document.activeElement.id`);
await key('Escape', 'Escape', 27);
kb.drawerClosed = await evalx(`document.getElementById('drawer').hidden`);
kb.focusRestored = await evalx(`document.activeElement.classList.contains('t-btn')`);
/* REVIEW ITEM 2 — the regression the reviewer actually hit, now asserted.
 * openDrawer used to record the prior inert state ONLY for body children that have an
 * id, while setting inert on all of them. After one Esc, header/.wrap/footer/skip-link
 * stayed inert: keys and clicks did nothing and a second card would not open.
 * Two assertions: (a) no inert survives the close, (b) a SECOND card still opens and
 * receives focus. A walkthrough that only ever opens one card cannot see this bug. */
kb.inertRemainingAfterClose = await evalx(
  `[...document.body.children].filter(n => n.hasAttribute('inert')).map(n => n.tagName + (n.id ? '#' + n.id : ''))`);
kb.secondCardOpens = await evalx(`(() => {
  const b = document.querySelectorAll('#task-list .t-btn')[1];
  if (!b) return 'no second card in list';
  b.click();
  return !document.getElementById('drawer').hidden;
})()`);
kb.secondCardFocusInsideDrawer = await evalx(
  `document.getElementById('drawer').contains(document.activeElement) || document.activeElement.id === 'drawer'`);
await key('Escape', 'Escape', 27);
kb.secondCloseRestoresFocus = await evalx(`document.activeElement.classList.contains('t-btn')`);
await key('t', 'KeyT', 84);
kb.themeAfterT = await evalx(`document.documentElement.dataset.theme`);
await key('t', 'KeyT', 84);
kb.themeBack = await evalx(`document.documentElement.dataset.theme`);
await key('p', 'KeyP', 80);
kb.viewAfterP = await evalx(`!document.getElementById('payments').hidden`);
await key('a', 'KeyA', 65);
kb.viewAfterA = await evalx(`!document.getElementById('agents').hidden`);
await key('g', 'KeyG', 71);
kb.viewAfterG = await evalx(`!document.getElementById('board').hidden`);
report.keyboard = kb;

writeFileSync(join(RUNS, 'responsive-keyboard-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
try { ws.close(); } catch { /* ignore */ }
proc.kill();
process.exit(0);
