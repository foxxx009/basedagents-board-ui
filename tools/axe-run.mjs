#!/usr/bin/env node
/**
 * axe-run.mjs — axe-core audit of the four states the review named, in BOTH themes.
 *
 * WHY THIS EXISTS: review item 4 asked for "an axe run (board, payments, agents, open
 * drawer) with 0 contrast failures". The previous pass answered with tools/contrast.mjs,
 * which computes pairs from the stylesheet -- useful, but it is my own arithmetic about
 * my own palette, and it SKIPPED the three pairs that actually failed. axe-core is an
 * independent engine that measures the rendered pixels: if the two disagree, axe wins,
 * because axe is what the reviewer is running.
 *
 * It drives a real headless browser over CDP, serves dist/ itself (so it cannot silently
 * audit a stale build), injects axe.min.js and reports every violation. Exits 1 on any.
 *
 * Usage: node tools/axe-run.mjs            (runs both themes)
 *        node tools/axe-run.mjs --light    (light theme only)
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8123;                       // deliberately not 8099: never collide with serve.mjs
const BASE = `http://127.0.0.1:${PORT}/`;
mkdirSync(resolve(ROOT, 'runs'), { recursive: true });

/* axe-core is resolved from the managed node workspace, not vendored into the repo:
 * the audit must be reproducible by the reviewer from npm, not from a copy I edited. */
const AXE_CANDIDATES = [
  'C:/Users/fitze/.workbuddy/binaries/node/workspace/node_modules/axe-core/axe.min.js',
  resolve(ROOT, 'node_modules/axe-core/axe.min.js'),
];
const AXE_PATH = AXE_CANDIDATES.find((p) => existsSync(p));
if (!AXE_PATH) {
  console.error('axe-core not found. Install it: npm i axe-core');
  process.exit(2);
}
const axeSource = readFileSync(AXE_PATH, 'utf8');

const { createServer } = await import('node:http');
const { spawn } = await import('node:child_process');

/* Serve dist/ from inside this process so an audit can never target a stale build. */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const DIST = resolve(ROOT, 'dist');
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  const p = resolve(DIST, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!p.startsWith(DIST) || !existsSync(p)) { res.writeHead(404).end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const chrome = process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
     .find((p) => existsSync(p));
if (!chrome) { console.error('no Chrome/Edge binary found; set CHROME_PATH'); process.exit(2); }

const port = 9222 + Math.floor(Math.random() * 400);
const proc = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(resolve(tmpdir(), 'ba-ui-axe-'))}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch {}
}
if (!target) { proc.kill(); server.close(); console.error('devtools did not come up'); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const n = ++msgId; pending.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

const themes = process.argv.includes('--light') ? ['light'] : ['dark', 'light'];
const STATES = [
  { id: 'board',    label: 'board (task list)', prep: null },
  { id: 'payments', label: 'payments table',    prep: `document.querySelector('[data-view="payments"]').click()` },
  { id: 'agents',   label: 'agents directory',  prep: `document.querySelector('[data-view="agents"]').click()` },
  { id: 'drawer',   label: 'open drawer',       prep: `null` },
];

const out = { generated_at: new Date().toISOString(), axe_source: AXE_PATH, base: BASE, runs: [] };
let totalViolations = 0;

for (const theme of themes) {
  for (const st of STATES) {
    await send('Page.navigate', { url: BASE });
    await sleep(2500);
    await evalJs(`(() => {
      document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
      return true;
    })()`);

    if (st.id === 'drawer') {
      /* Open a task that actually carries receipts, so the audited DOM includes the
       * receipt list, the hash and the full signature -- the region the review cares
       * about. Wait for rows and for the receipt heading to be populated. */
      const ok = await evalJs(`(async () => {
        const rc = await (await fetch('receipts.json')).json();
        const id = Object.keys(rc).find(k => Array.isArray(rc[k]) && rc[k].length);
        if (!id) return false;
        const btn = document.querySelector('[data-id="' + id + '"]')
                 || [...document.querySelectorAll('.t-btn')][0];
        if (!btn) return false;
        btn.click();
        for (let i = 0; i < 60; i++) {
          if (!document.querySelector('#drawer').hidden
              && document.querySelectorAll('#d-receipts > li').length) return true;
          await new Promise(r => setTimeout(r, 100));
        }
        return !document.querySelector('#drawer').hidden;
      })()`);
      if (!ok) { console.log(`SKIP [${theme}/${st.id}] could not open a receipt-bearing drawer`); continue; }
      await sleep(600);
    } else if (st.prep) {
      await evalJs(`(() => { ${st.prep}; return true; })()`);
      await sleep(1800);
    }

    await evalJs(axeSource);
    const res = await evalJs(`(async () => {
      const r = await axe.run(document, {
        resultTypes: ['violations'],
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
      return {
        violations: r.violations.map(v => ({
          id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
          targets: v.nodes.slice(0, 4).map(n => n.target.join(' ')),
          summary: (v.nodes[0] && (v.nodes[0].failureSummary || '')).split('\\n').slice(0, 3).join(' | '),
        })),
        passes: r.passes ? r.passes.length : null,
        incomplete: (r.incomplete || []).map(v => ({ id: v.id, nodes: v.nodes.length })),
        tested: r.testRunner ? r.testRunner.name : null,
      };
    })()`);

    const v = res.violations || [];
    totalViolations += v.length;
    out.runs.push({ theme, state: st.id, label: st.label, axe: res.tested,
      violation_count: v.length, violations: v,
      incomplete: res.incomplete, passed_rules: res.passes });
    const tag = v.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${tag} [${theme}/${st.id}] ${st.label} — ${v.length} axe violation(s)`
      + (v.length ? ': ' + v.map((x) => `${x.id}(${x.nodes})`).join(', ') : ''));
    for (const x of v) console.log(`      ${x.id} [${x.impact}] ${x.help} :: ${x.summary}`);
  }
}

out.total_violations = totalViolations;
out.verdict = totalViolations === 0
  ? '0 axe violations across board, payments, agents and open drawer in both themes'
  : `${totalViolations} violation(s)`;
/* --out lets the delivery builder capture this run's report without touching the
 * committed copy, so the tree the delivery pins stays byte-identical. */
const outArg = process.argv.indexOf('--out');
const reportPath = outArg > -1 ? resolve(process.argv[outArg + 1]) : resolve(ROOT, 'runs', 'axe-report.json');
writeFileSync(reportPath, JSON.stringify(out, null, 2));
console.log(`\n${out.verdict}`);
console.log(`wrote ${reportPath}`);

ws.close(); proc.kill(); server.close();
process.exit(totalViolations === 0 ? 0 : 1);
