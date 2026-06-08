// B0 feasibility spike — render-test the bundled mermaid+ELK preview under CSP.
//
// Loads the REAL dist/webview/preview.js (mermaid 11 + ELK, esbuild IIFE) into
// chromium via playwright-core, under several Content-Security-Policy variants,
// and measures: (a) does it render an <svg>? (b) does ELK layout resolve? (c)
// what CSP does mermaid actually need (which directives get violated)? (d) render
// time on a baseline (dagre) diagram and the gnarly FrameworkFlow (elk) one.
//
// Output: a verdict table on stdout + screenshots -> artifacts/b0-*.png.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const BUNDLE = path.join(ROOT, 'dist/webview/preview.js');
const OUT = path.join(ROOT, 'artifacts');
const EXEC =
  process.env.PW_CHROMIUM ||
  path.join(process.env.HOME, '.local/share/playwright-chromium-current');
const NONCE = 'spikeNonce0xB0';

// --- diagrams under test -----------------------------------------------------
const demo = fs.readFileSync(path.join(ROOT, 'examples/demo.mmd'), 'utf8'); // dagre baseline

// Pull the ```mermaid block out of FrameworkFlow.md and force ELK on it (the
// real big diagram). The .md frontmatter `layout: elk` lives outside the fence,
// so we prepend mermaid-native frontmatter to exercise the ELK code path.
const ff = fs.readFileSync(path.join(ROOT, 'examples/FrameworkFlow.md'), 'utf8');
const block = ff.match(/```mermaid\s*\n([\s\S]*?)\n```/);
const elkDiagram = '---\nconfig:\n  layout: elk\n---\n' + (block ? block[1] : 'graph LR\nA-->B');

// --- CSP variants (the question B0 must answer) ------------------------------
// 'self' lets the file:// page's own origin serve; img/font include data:.
const CSP = {
  strict:
    `default-src 'none'; img-src 'self' data: blob:; font-src 'self' data:; ` +
    `style-src 'nonce-${NONCE}'; script-src 'nonce-${NONCE}';`,
  styleUnsafeInline:
    `default-src 'none'; img-src 'self' data: blob:; font-src 'self' data:; ` +
    `style-src 'unsafe-inline'; script-src 'nonce-${NONCE}';`,
};

function harnessHtml(csp) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${NONCE}">body{margin:0;background:#1e1e1e}#preview{padding:8px}</style>
</head><body>
<div id="preview"></div>
<script nonce="${NONCE}">
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__violations.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: (e.sample||'').slice(0,40) });
  });
  window.acquireVsCodeApi = () => ({ postMessage(){}, getState(){}, setState(){} });
</script>
<script nonce="${NONCE}" src="../../dist/webview/preview.js"></script>
</body></html>`;
}

async function renderUnder(page, label, csp, code, id) {
  const file = path.join(__dirname, `harness-${label}-${id}.html`);
  fs.writeFileSync(file, harnessHtml(csp));
  const consoleErrs = [];
  page.removeAllListeners('console');
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 200)); });
  const pageErrs = [];
  page.removeAllListeners('pageerror');
  page.on('pageerror', (e) => pageErrs.push(String(e).slice(0, 200)));

  await page.goto('file://' + file);
  // wait for the bundle to boot (preview-ready) — or fail fast if it never loads
  let booted = false;
  try {
    await page.waitForFunction(() => window.__lastResult && window.__lastResult.type === 'preview-ready', { timeout: 8000 });
    booted = true;
  } catch { /* bundle didn't boot under this CSP */ }

  let result = null;
  if (booted) {
    await page.evaluate((args) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'render', code: args.code, id: args.id, theme: 'dark' } })), { code, id });
    try {
      await page.waitForFunction(() => window.__lastResult && window.__lastResult.type === 'rendered', { timeout: 15000 });
      result = await page.evaluate(() => window.__lastResult);
    } catch { /* render hung */ }
  }

  // inspect the actual DOM that landed
  const probe = await page.evaluate(() => {
    const svg = document.querySelector('#preview svg');
    if (!svg) return { svg: false };
    const nodes = svg.querySelectorAll('.node, .nodes .node, g.node').length;
    const edges = svg.querySelectorAll('.edgePath, .edge, path.flowchart-link').length;
    const hasStyleEl = !!svg.querySelector('style');
    // is styling actually applied? sample a node rect's fill.
    const rect = svg.querySelector('.node rect, .node polygon, rect, polygon');
    let fill = rect ? getComputedStyle(rect).fill : '';
    return { svg: true, w: svg.getBBox ? Math.round(svg.getBBox().width) : 0, nodes, edges, hasStyleEl, fill };
  });

  const violations = await page.evaluate(() => window.__violations);
  await page.screenshot({ path: path.join(OUT, `b0-${label}-${id}.png`) });
  try { fs.unlinkSync(file); } catch {}
  return { booted, result, probe, violations, consoleErrs, pageErrs };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });

  const matrix = [
    ['strict', CSP.strict, demo, 'demo-dagre'],
    ['strict', CSP.strict, elkDiagram, 'framework-elk'],
    ['unsafeInline', CSP.styleUnsafeInline, demo, 'demo-dagre'],
    ['unsafeInline', CSP.styleUnsafeInline, elkDiagram, 'framework-elk'],
  ];

  const rows = [];
  for (const [label, csp, code, id] of matrix) {
    const r = await renderUnder(page, label, csp, code, id);
    rows.push([label, id, r]);
    const v = (r.violations || []).map((x) => x.directive).filter((d, i, a) => a.indexOf(d) === i);
    console.log(`\n### CSP=${label}  diagram=${id}`);
    console.log(`  booted:        ${r.booted}`);
    console.log(`  render result: ${r.result ? `ok=${r.result.ok} ms=${r.result.ms}${r.result.error ? ' err=' + r.result.error.slice(0, 120) : ''}` : 'NONE (hung/failed)'}`);
    console.log(`  svg in DOM:    ${r.probe.svg}${r.probe.svg ? `  nodes=${r.probe.nodes} edges=${r.probe.edges} styleEl=${r.probe.hasStyleEl} sampleFill=${r.probe.fill}` : ''}`);
    console.log(`  CSP violations: ${v.length ? v.join(', ') : 'none'}`);
    if (r.consoleErrs.length) console.log(`  console errors: ${r.consoleErrs.slice(0, 3).join(' | ')}`);
    if (r.pageErrs.length) console.log(`  page errors:    ${r.pageErrs.slice(0, 3).join(' | ')}`);
  }

  await browser.close();
  console.log('\n=== screenshots in artifacts/b0-*.png ===');
})().catch((e) => { console.error('SPIKE FAILED:', e); process.exit(1); });
