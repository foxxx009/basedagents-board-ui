#!/usr/bin/env node
/**
 * contrast.mjs — WCAG 2.1 AA contrast audit for the board's own palette.
 *
 * WHY A SCRIPT: the first delivery claimed "accessibility 100" from a Lighthouse run in
 * DARK theme only, and the light theme failed axe on the small pills. Reading the CSS by
 * eye does not settle this — so this tool parses the real :root / [data-theme="light"]
 * blocks out of styles.css and computes every foreground/background pair the UI
 * actually renders.
 *
 * Thresholds: 4.5 for normal text (the pills are 0.68rem, so they are NOT large text
 * and do not qualify for the 3.0 large-text allowance), 3.0 for UI borders.
 *
 * Usage: node tools/contrast.mjs [--json]
 * Exit 1 if any pair fails, so it can gate a build.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(ROOT, 'dist', 'styles.css'), 'utf8');

/** Pull `--name:#hex;` pairs out of a CSS block starting at `header`. */
function varsFor(header) {
  const start = css.indexOf(header);
  if (start === -1) throw new Error('block not found: ' + header);
  const open = css.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  const body = css.slice(open + 1, end);
  const vars = {};
  for (const m of body.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    vars[m[1]] = m[2].length === 4
      ? '#' + [...m[2].slice(1)].map((c) => c + c).join('')
      : m[2].slice(0, 7);
  }
  return vars;
}

const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => {
  const h = hex.replace('#', '');
  return 0.2126 * srgb(parseInt(h.slice(0, 2), 16))
       + 0.7152 * srgb(parseInt(h.slice(2, 4), 16))
       + 0.0722 * srgb(parseInt(h.slice(4, 6), 16));
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// Foreground/background pairs that the stylesheet really renders together.
const PAIRS = [
  ['body text', 'fg', 'bg', 4.5],
  ['card text', 'fg', 'card', 4.5],
  ['muted on card', 'fg-3', 'card', 4.5],
  ['pill text on card-2', 'fg-2', 'card-2', 4.5],
  ['muted on card-2', 'fg-3', 'card-2', 4.5],   // .pill.free
  ['bounty pill', 'ok', 'card-2', 4.5],        // .pill.bounty
  ['submitted pill', 'acc', 'card-2', 4.5],    // .pill.s-submitted
  ['open pill', 'info', 'card-2', 4.5],        // .pill.s-open
  ['claimed pill', 'warn', 'card-2', 4.5],     // .pill.s-claimed
  ['link on bg', 'acc', 'bg', 4.5],
  ['link on card', 'acc', 'card', 4.5],
  // WCAG 1.4.11 (non-text contrast) applies to the boundary of a control when that
  // boundary is what identifies the control -- not to decorative dividers. .pill borders
  // are listed separately below because a pill IS a control surface.
  ['pill border vs card-2', 'line-2', 'card-2', 3.0],
  ['kbd border vs card-2', 'line-2', 'card-2', 3.0],
  /* REVISION FIX (review item 4). The previous pass asserted "27/27 pass" while
   * SKIPPING the three pairs axe actually fails on:
   *   - text on an --acc fill: the skip link, the active tab and a pressed chip. The
   *     literal #04211d measured 2.76 against the light theme's dark teal.
   *   - the TINTED pills. .pill.bounty / .pill.settled do not sit on a flat card; they
   *     sit on color-mix(in srgb, var(--ok) 16%|20%, transparent) over --card-2, which
   *     lifts the background TOWARD the text colour and measured 4.04 and 3.81.
   * A contrast tool that omits the pairs it would fail is worse than no tool, so the
   * tint is now resolved by blending in sRGB exactly as color-mix does, and the
   * background is recorded in the output so a reviewer can check the arithmetic. */
  ['text on acc fill (skip link, active tab, pressed chip)', 'on-acc', 'acc', 4.5],
  ['bounty pill on 16% ok tint', 'ok', 'tint:ok:16:card-2', 4.5],
  ['settled pill on 20% ok tint', 'ok', 'tint:ok:20:card-2', 4.5],
  ['open pill on untinted card-2', 'info', 'card-2', 4.5],
  ['claimed pill on untinted card-2', 'warn', 'card-2', 4.5],
];

/** Resolve a background spec: either a var name or `tint:<var>:<pct>:<base>`.
 *  color-mix(in srgb, C p%, transparent) over B == p% C + (1-p%) B per channel. */
function resolveBg(spec, vars) {
  if (!spec.startsWith('tint:')) return { hex: vars[spec], note: null };
  const [, fgv, pct, base] = spec.split(':');
  const p = Number(pct) / 100;
  const mixHex = (a, b) => {
    const ch = (h, i) => parseInt(h.replace('#', '').slice(i * 2, i * 2 + 2), 16);
    const out = [0, 1, 2].map((i) => Math.round(ch(a, i) * p + ch(b, i) * (1 - p)));
    return '#' + out.map((c) => c.toString(16).padStart(2, '0')).join('');
  };
  return {
    hex: mixHex(vars[fgv], vars[base]),
    note: `${pct}% ${vars[fgv]} over ${vars[base]}`,
  };
}

const themes = { dark: varsFor(':root'), light: varsFor('[data-theme="light"]') };
const results = [];
for (const [theme, vars] of Object.entries(themes)) {
  for (const [label, fg, bg, need] of PAIRS) {
    const bgSpec = resolveBg(bg, vars);
    if (!vars[fg] || !bgSpec.hex) { results.push({ theme, label, ratio: null, need, pass: null, note: 'missing var' }); continue; }
    const r = ratio(vars[fg], bgSpec.hex);
    results.push({ theme, label, fg: vars[fg], bg: bgSpec.hex, ratio: Number(r.toFixed(2)), need, pass: r >= need, note: bgSpec.note });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ tool: 'contrast.mjs', results }, null, 2));
} else {
  for (const t of ['dark', 'light']) {
    console.log(`\n== ${t.toUpperCase()} THEME (AA: text ${4.5}, UI ${3.0})`);
    for (const r of results.filter((x) => x.theme === t)) {
      const verdict = r.pass === null ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
      console.log(`${verdict.padEnd(5)} ${r.label.padEnd(22)} ${String(r.ratio ?? '-').padStart(6)}  (need ${r.need})`);
    }
  }
}
const failed = results.filter((r) => r.pass === false);
console.log(`\n${failed.length === 0 ? 'ALL PAIRS PASS' : failed.length + ' PAIR(S) FAIL'}`);
process.exit(failed.length === 0 ? 0 : 1);