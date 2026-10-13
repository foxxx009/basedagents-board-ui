/* dbg_search.cjs — one-off diagnosis of the full-text search path in a real browser. */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9900 + Math.floor(Math.random() * 90);

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-dbg-'));
  const child = spawn(EXE, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let wsUrl;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch {}
  }
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
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
    return r.result.value;
  };

  await S('Page.navigate', { url: 'http://127.0.0.1:8099/' });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (await evalx(`document.body.dataset.ready === '1'`)) break;
  }
  console.log('ready. rows:', await evalx(`document.querySelectorAll('#task-list .task').length`));

  await evalx(`(() => { const i=document.querySelector('#q'); i.value='qualification'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(3000);
  console.log('after query rows:', await evalx(`document.querySelectorAll('#task-list .task').length`));
  console.log('count text:', await evalx(`document.querySelector('#count').textContent`));

  // probe the internals: app.js runs as a classic script, so its top-level consts
  // live in the script scope, not on window. Re-derive the state from behaviour:
  const direct = await evalx(`(async () => {
    const r = await fetch('details-0.json', { cache: 'force-cache' });
    const j = await r.json();
    const keys = Object.keys(j);
    const first = j[keys[0]] || {};
    return { chunkKeys: keys.length, firstKeys: Object.keys(first), hasSearchText: typeof first.search_text };
  })()`);
  console.log('details-0 probe:', JSON.stringify(direct));

  const hit = await evalx(`(async () => {
    const r = await fetch('details-0.json', { cache: 'force-cache' });
    const j = await r.json();
    let n = 0;
    for (const rec of Object.values(j)) {
      if (rec && typeof rec.search_text === 'string' && rec.search_text.toLowerCase().includes('qualification')) n++;
    }
    return n;
  })()`);
  console.log('qualification hits inside details-0 alone:', hit);

  child.kill();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
