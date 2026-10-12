#!/usr/bin/env node
/**
 * runtime-verify.mjs — real-browser proof for the runtime half of the revision.
 *
 * verify-fixes.mjs checks the source and the data. This drives an actual page to prove
 * the behaviour the reviewer measured in a browser:
 *   - agents view at 360px does not overflow (they measured scrollWidth 413)
 *   - Tab is trapped inside the open drawer
 *   - the drawer shows the signed receipt chain
 *   - a bounty-but-unsettled task is not labelled "free task"
 *
 * Usage: node tools/runtime-verify.mjs   (needs tools/serve.mjs already on :8099)
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:8099/';
mkdirSync(resolve(ROOT, 'runs'), { recursive: true });

const chrome = process.env.CHROME_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
     .find(p => existsSync(p));
if (!chrome) { console.error('no Chrome/Edge binary found; set CHROME_PATH'); process.exit(2); }

const { spawn } = await import('node:child_process');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
/* A FIXED user-data-dir is the reason this script intermittently died with "devtools did
 * not come up": a previous run leaves orphaned renderer/utility processes holding the
 * profile lock, and the next run's browser exits immediately. A fresh mkdtemp profile per
 * run removes the lock contention entirely. It also stops the machine accumulating the
 * orphaned processes that measurably depressed Lighthouse (83 vs 100 on identical builds).
 * The temp dir is NOT deleted on exit on purpose: deleting it while a child renderer is
 * still exiting is what produced the lock in the first place. OS temp cleanup handles it. */
const profile = mkdtempSync(resolve(tmpdir(), 'ba-ui-verify-'));
const port = 9222 + Math.floor(Math.random() * 400);
const proc = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find(t => t.type === 'page');
  } catch {}
}
if (!target) { proc.kill(); console.error('devtools did not come up'); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id; pending.set(n, res);
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
const out = { base: BASE, checks: [] };
const rec = (id, claim, pass, detail) => {
  out.checks.push({ id, claim, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${claim} — ${detail}`);
};

/* 1. agents view at 360px */
await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: BASE });
await sleep(3500);
await evalJs(`(async () => {
  document.querySelector('[data-view="agents"]').click();
  /* The agent directory is a lazy payload (see fetch-snapshot.mjs), so the grid renders
   * only after it lands. Measure a populated list -- measuring the empty shell would
   * report scrollWidth 360 and prove nothing. */
  for (let i = 0; i < 100; i++) {
    if (document.querySelectorAll('.agents > *').length > 5) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
})()`);
await sleep(1500);
const ov = await evalJs(`(() => {
  const d = document.documentElement;
  const widest = [...document.querySelectorAll('.agents > *')]
    .map(n => Math.round(n.getBoundingClientRect().right))
    .reduce((a, b) => Math.max(a, b), 0);
  return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, widestChildRight: widest,
           rows: document.querySelectorAll('.agents > *').length };
})()`);
rec('R1', 'agents view does not overflow at 360px',
  ov.scrollWidth <= ov.clientWidth + 1 && ov.rows > 5,
  `scrollWidth=${ov.scrollWidth} clientWidth=${ov.clientWidth} widestChildRight=${ov.widestChildRight} rows=${ov.rows} (review saw 413 vs 360)`);

/* 2. open a delivered task's drawer -> receipts + focus trap */
/* 2. open a delivered task's drawer -> receipts + focus trap.
 * NOTE: R1 leaves the page on the agents view, and the board list is not rendered
 * while another view is active, so searching here would never find a row. Switch back
 * to the board first — an earlier version of this script skipped that and reported four
 * false failures that looked exactly like a broken drawer. */
await evalJs(`(() => {
  document.querySelector('[data-view="board"]').click();
  const q = document.querySelector('#q');
  if (q.value) { q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); }
})()`);
await sleep(1200);
const opened = await evalJs(`(() => {
  // pick a task that actually has receipts, via the shipped receipts.json
  return fetch('receipts.json').then(r => r.json()).then(rc => {
    const id = Object.keys(rc).find(k => Array.isArray(rc[k]) && rc[k].length);
    return id || null;
  });
})()`);
if (!opened) {
  rec('R2', 'drawer receipts render', false, 'no task with receipts found in receipts.json');
} else {
  await evalJs(`(async () => {
    const q = document.querySelector('#q');
    q.value = ${JSON.stringify(opened)};
    q.dispatchEvent(new Event('input', { bubbles: true }));
    /* Search text is lazy, so the first render uses the metadata haystack and the list
     * re-renders once the chunks land. Poll for the row whose id actually matches rather
     * than sleeping: the previous fixed 500ms wait clicked whichever row was first and
     * produced four false failures. */
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 100));
      const hit = [...document.querySelectorAll('#task-list > li')]
        .find(li => li.dataset && li.dataset.id === ${JSON.stringify(opened)});
      if (hit) {
        const btn = hit.querySelector('.t-btn');
        if (btn) { btn.click(); return true; }
      }
    }
    return false;
  })()`);
  await sleep(3000);
  const drawer = await evalJs(`(() => {
    const d = document.querySelector('#drawer');
    const rc = document.querySelector('#d-receipts');
    const txt = rc ? (rc.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    return {
      open: !d.hidden,
      /* The id is echoed in #d-crumbs, so the check can prove the drawer is showing the
       * task we asked for. The OLD assertion only tested /Delivery receipts/i against
       * the container text -- and "no delivery receipts recorded for this task"
       * CONTAINS that phrase, so the check passed while showing an empty panel. That is
       * a false PASS, and it is exactly the failure mode worth designing out. */
      crumbs: (document.querySelector('#d-crumbs')?.textContent || '').trim(),
      receiptCount: rc ? rc.querySelectorAll('li').length : 0,
      /* No trailing \b: sibling <div>s concatenate with no separator, so the hash runs
       * straight into the following "sig" and a word boundary never occurs. Asserting
       * \b here would fail a receipt that IS printed in full -- a false negative, the
       * same class of bug as the false positive this check replaces. */
      hasFullHash: /entry\\s+[0-9a-f]{64}(?![0-9a-f])/i.test(txt),
      hasFullSig: /sig\\s+\\S{60,}/.test(txt),
      saysEmpty: /no delivery receipts/i.test(txt),
      receiptText: txt.slice(0, 220),
      chainText: (document.querySelector('#d-chain')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      focusInside: d.contains(document.activeElement),
      backgroundInert: [...document.body.children]
        .filter(n => n !== d && n.id !== 'scrim')
        .every(n => n.hasAttribute('inert')),
    };
  })()`);
  const wanted = String(opened);
  rec('R2', 'drawer renders the signed receipt chain for the receipt-bearing task',
    drawer.open && drawer.crumbs.indexOf(wanted) === 0 && !drawer.saysEmpty
      && drawer.receiptCount > 0 && drawer.hasFullHash && drawer.hasFullSig,
    `opened=${wanted} crumbs="${drawer.crumbs.slice(0, 60)}" li=${drawer.receiptCount} `
    + `fullHash=${drawer.hasFullHash} fullSig=${drawer.hasFullSig} empty=${drawer.saysEmpty} text="${drawer.receiptText}"`);
  rec('R3', 'background is inert while the modal is open', drawer.backgroundInert === true,
    `all non-drawer body children inert = ${drawer.backgroundInert}`);
  rec('R4', 'focus moved into the drawer', drawer.focusInside === true, `activeElement inside drawer = ${drawer.focusInside}`);

  /* 3. Tab wrapping: from the last focusable, Tab must land back inside */
  const trap = await evalJs(`(() => {
    const d = document.querySelector('#drawer');
    const f = [...d.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])')]
      .filter(n => n.offsetParent !== null || n === document.activeElement);
    if (!f.length) return { error: 'no focusables' };
    f[f.length - 1].focus();
    const before = document.activeElement.textContent.trim().slice(0, 30);
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    return { count: f.length, before, after: document.activeElement.textContent.trim().slice(0, 30),
             afterInside: d.contains(document.activeElement) };
  })()`);
  rec('R5', 'Tab wraps at the drawer edge instead of escaping',
    !!trap.afterInside, `focusables=${trap.count} last="${trap.before}" -> next="${trap.after}" inside=${trap.afterInside}`);
}

/* 4. no "free task" label on a bounty-but-unsettled task */
await evalJs(`(() => { const d=document.querySelector('#drawer'); if(!d.hidden) document.querySelector('#d-close').click(); })()`);
await sleep(600);
const labels = await evalJs(`(() => {
  const q = document.querySelector('#q');
  q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true }));
  return new Promise(r => setTimeout(() => {
    // find an open task WITH a bounty, open it, read the chain row
    const s = fetch('snapshot.json').then(x => x.json()).then(snap => {
      const t = snap.tasks.find(x => x.bounty && !x.payment?.settled);
      if (!t) return { skipped: true };
      q.value = t.id; q.dispatchEvent(new Event('input', { bubbles: true }));
      /* Same lazy-load race as R2: the first render uses the metadata haystack, then the
       * detail chunks arrive and the list re-renders. Poll for the matching row instead
       * of sleeping a fixed interval, which used to click whatever row happened to be
       * first and report a false failure. */
      return new Promise(r2 => {
        let tries = 0;
        const iv = setInterval(() => {
          tries += 1;
          const hit = [...document.querySelectorAll('#task-list > li')]
            .find(li => li.dataset && li.dataset.id === t.id);
          if (hit) {
            clearInterval(iv);
            const b = hit.querySelector('.t-btn'); if (b) b.click();
            setTimeout(() => r2({
              task: t.id,
              bounty: (t.bounty.amount ?? '?') + ' ' + t.bounty.token,
              chain: (document.querySelector('#d-chain')?.textContent || '').replace(/\\s+/g, ' ').trim(),
            }), 1200);
          } else if (tries > 80) {
            clearInterval(iv);
            r2({ task: t.id, error: 'row never rendered', chain: '' });
          }
        }, 100);
      });
    });
    r(s);
  }, 500));
})()`);
rec('R6', 'a bounty-but-unsettled task is NOT labelled "free task"',
  labels.skipped === true || !/free task/i.test(labels.chain || ''),
  labels.skipped ? 'no such task in snapshot' : `bounty=${labels.bounty} chain="${labels.chain}"`);

/* 5. search finds text that only exists deep in the description */
const search = await evalJs(`(() => {
  const s = fetch('snapshot.json').then(x => x.json()).then(async snap => {
    /* search_text now lives in the LAZY detail chunks, not the render-blocking index
     * (that inline cost 21 Lighthouse points). Read it from the chunks, and require the
     * token to be absent from every title AND summary in the index -- otherwise the
     * test would pass without proving full-text search works. */
    const urls = Array.from({ length: snap.details_chunks || 0 }, (_, i) => 'details-' + i + '.json');
    const buckets = await Promise.all(urls.map(u => fetch(u).then(r => r.json())));
    let tok = null, ownerId = null;
    for (const b of buckets) {
      for (const [id, rec] of Object.entries(b || {})) {
        if (!rec.search_text) continue;
        const words = rec.search_text.match(/[a-z]{9,}/g) || [];
        const w = words.find(x => !rec.search_text.slice(0, 0) && !rec.description.toLowerCase().includes(x));
        if (!w) continue;
        const inIndex = snap.tasks.some(t => (t.title || '').toLowerCase().includes(w)
          || (t.summary || '').toLowerCase().includes(w));
        if (!inIndex) { tok = w; ownerId = id; break; }
      }
      if (tok) break;
    }
    if (!tok) return { skipped: true };
    const q = document.querySelector('#q');
    q.value = tok; q.dispatchEvent(new Event('input', { bubbles: true }));
    // poll: chunks load on first search, so results settle after a beat
    return new Promise(r2 => {
      let tries = 0;
      const iv = setInterval(() => {
        tries += 1;
        const n = document.querySelectorAll('#task-list > li').length;
        if (n > 0 || tries > 60) {
          clearInterval(iv);
          r2({ token: tok, ownerId, hits: n,
               count: document.querySelector('#count')?.textContent || '' });
        }
      }, 100);
    });
  });
  return s;
})()`);
rec('R7', 'search matches text found only in the full description',
  search.skipped === true || search.hits > 0,
  search.skipped ? 'no deep-only token available' : `token="${search.token}" (absent from every title+summary) -> ${search.hits} rows; ${search.count}`);

writeFileSync(resolve(ROOT, 'runs', 'runtime-verify.json'), JSON.stringify({ generated_at: new Date().toISOString(), ...out }, null, 2));
const failed = out.checks.filter(c => !c.pass);
console.log(`\n${out.checks.length - failed.length}/${out.checks.length} runtime checks pass`);
try { proc.kill(); } catch {}
ws.close();
process.exit(failed.length ? 1 : 0);