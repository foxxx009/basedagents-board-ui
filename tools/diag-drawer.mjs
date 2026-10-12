// Focused diagnostic: why doesn't the drawer open when a row is clicked?
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find(p => existsSync(p));
const port = 9411;
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${port}`, `--user-data-dir=${resolve(ROOT, '.chrome-diag')}`, 'about:blank'],
  { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let t = null;
for (let i = 0; i < 40 && !t; i++) {
  await sleep(500);
  try { t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page'); } catch {}
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(res => { const n = ++id; pend.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8099/' });
await sleep(4000);

console.log('rows rendered:', await ev(`document.querySelectorAll('#task-list > li').length`));
console.log('first li dataset:', JSON.stringify(await ev(`(()=>{const l=document.querySelector('#task-list > li');return l?{id:l.dataset.id,hasBtn:!!l.querySelector('.t-btn')}:null})()`)));

console.log('\n-- click the first row button directly:');
console.log(await ev(`(async()=>{
  const li=document.querySelector('#task-list > li');
  const btn=li&&li.querySelector('.t-btn');
  if(!btn) return 'no btn';
  btn.click();
  await new Promise(r=>setTimeout(r,1500));
  const d=document.querySelector('#drawer');
  return JSON.stringify({drawerHidden:d.hidden, title:(document.querySelector('#d-title')||{}).textContent, crumbs:(document.querySelector('#d-crumbs')||{}).textContent});
})()`));

console.log('\n-- does openDrawer exist and is it wired?');
console.log(await ev(`typeof openDrawer`));
console.log('listeners on first li (via getEventListeners not available in page ctx):',
  await ev(`(()=>{const l=document.querySelector('#task-list > li'); return l? l.outerHTML.slice(0,300):'none'})()`));

console.log('\n-- try dispatching a real click on the LI (the card handler):');
console.log(await ev(`(async()=>{
  const d=document.querySelector('#drawer');
  if(!d.hidden) document.querySelector('#d-close').click();
  await new Promise(r=>setTimeout(r,400));
  const li=document.querySelector('#task-list > li');
  li.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  await new Promise(r=>setTimeout(r,1500));
  return JSON.stringify({drawerHidden:d.hidden, title:(document.querySelector('#d-title')||{}).textContent});
})()`));


console.log('-- search by a task id and watch the row count over time:');
console.log(await ev(`(async()=>{
  const target='${'task_OC8NWVZOr96vW9RzgThN1'}';
  const q=document.querySelector('#q');
  q.value=target; q.dispatchEvent(new Event('input',{bubbles:true}));
  const samples=[];
  for(let i=0;i<12;i++){
    await new Promise(r=>setTimeout(r,250));
    const rows=[...document.querySelectorAll('#task-list > li')];
    samples.push({t:i*250, n:rows.length, ids:rows.slice(0,2).map(x=>x.dataset.id), hasTarget:rows.some(x=>x.dataset.id===target)});
  }
  return JSON.stringify(samples,null,1);
})()`));

proc.kill(); ws.close(); process.exit(0);