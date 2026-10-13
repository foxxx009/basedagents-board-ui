// lh_fresh.cjs — run Lighthouse against the local board with a FRESH browser
// profile each time (the review's acceptance criterion). chrome-launcher's
// --remote-debugging-port=0 + stderr parsing does not work with Edge on Windows
// (Edge never prints "DevTools listening on" to stderr), so we launch Edge
// ourselves on a fixed port and poll /json/version, then hand the port to
// Lighthouse programmatically.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8099/';
const OUT = process.argv[3] || 'runs/lh.report.json';
const PORT = 9222 + Math.floor(Math.random() * 500);

async function waitPort(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-fresh-'));
  const child = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    if (!(await waitPort(PORT))) {
      console.error('browser debugging port never came up');
      process.exit(1);
    }
    // NODE_PATH is invisible to ESM import(); resolve lighthouse by absolute path.
    const req = require('module').createRequire(
      'C:/Users/fitze/.workbuddy/binaries/node/workspace/node_modules/lighthouse/core/index.js'
    );
    const mod = await import(
      'file:///C:/Users/fitze/.workbuddy/binaries/node/workspace/node_modules/lighthouse/core/index.js'
    );
    const lighthouse = mod.default || mod;
    void req;
    const result = await lighthouse(URL_TARGET, {
      port: PORT,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    });
    // The report object is large; persist exactly what the CLI would have.
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(OUT), result.report);
    const lhr = result.lhr;
    const c = lhr.categories;
    const m = lhr.audits['largest-contentful-paint'] || {};
    console.log(JSON.stringify({
      performance: c.performance.score,
      accessibility: c.accessibility.score,
      'best-practices': c['best-practices'].score,
      seo: c.seo.score,
      LCP: m.displayValue || null,
      LCP_numeric: m.numericValue || null,
      CLS: (lhr.audits['cumulative-layout-shift'] || {}).displayValue || null,
      TBT: (lhr.audits['total-blocking-time'] || {}).displayValue || null,
      FCP: (lhr.audits['first-contentful-paint'] || {}).displayValue || null,
    }));
  } finally {
    child.kill();
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
