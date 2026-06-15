// B1 render-surface verification — drives the REAL preview assets (the actual
// src/webview/preview/index.html template + bundled dist/webview/preview.js)
// through the production message contract in headless chromium, and asserts the
// four B1 behaviours: flowchart render, ELK-via-frontmatter render, unsupported
// notice, and parse-error state. (Transitional; folds into the B4 visual harness.)
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'artifacts');
const EXEC = process.env.PW_CHROMIUM || path.join(process.env.HOME, '.local/share/playwright-chromium-current');
const NONCE = 'b1Nonce0x1234';

// Build the harness HTML from the real template (substitute as panel.ts does).
const template = fs.readFileSync(path.join(ROOT, 'src/webview/preview/index.html'), 'utf8');
const harnessHtml = template
  .replace(/{{cspSource}}/g, "'self'")
  .replace(/{{nonce}}/g, NONCE)
  .replace(/{{scriptUri}}/g, '../../dist/webview/preview.js');
const harnessFile = path.join(__dirname, 'b1-harness.html');

const demo = fs.readFileSync(path.join(ROOT, 'examples/demo.mmd'), 'utf8');
const ol = fs.readFileSync(path.join(ROOT, 'examples/order-lifecycle.md'), 'utf8');
const olBlock = ol.match(/```mermaid\s*\n([\s\S]*?)\n```/)[1];
const elk = '---\nconfig:\n  layout: elk\n---\n' + olBlock; // mirrors buildDiagramSource's injection

async function send(page, msg) {
  await page.evaluate((m) => window.dispatchEvent(new MessageEvent('message', { data: m })), msg);
}
async function lastResult(page) {
  await page.waitForFunction(() => window.__lastResult && window.__lastResult.type === 'rendered', { timeout: 15000 });
  return page.evaluate(() => window.__lastResult);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(harnessFile, harnessHtml);
  const browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  const violations = [];
  await page.exposeFunction('__noteViolation', (d) => violations.push(d));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => window.__noteViolation(e.violatedDirective));
  });

  await page.goto('file://' + harnessFile);
  await page.waitForFunction(() => window.__lastResult && window.__lastResult.type === 'preview-ready', { timeout: 8000 });

  // 1) flowchart renders
  await send(page, { type: 'render', code: demo, id: 'm1', theme: 'dark' });
  let r = await lastResult(page);
  assert.ok(r.ok && r.hasSvg, '1) demo flowchart should render an svg');
  assert.equal(await page.locator('#preview svg').count(), 1, '1) one svg in #preview');
  assert.ok(await page.locator('#state').evaluate((e) => e.classList.contains('hidden')), '1) state hidden on success');
  await page.screenshot({ path: path.join(OUT, 'b1-1-flowchart.png') });

  // 2) ELK-via-frontmatter renders (the order-lifecycle example case)
  await send(page, { type: 'render', code: elk, id: 'm2', theme: 'dark' });
  r = await lastResult(page);
  assert.ok(r.ok && r.hasSvg, '2) elk diagram should render');
  const nodeCount = await page.locator('#preview svg .node, #preview svg g.node').count();
  assert.ok(nodeCount >= 25, `2) elk order-lifecycle should render many nodes (got ${nodeCount})`);
  await page.screenshot({ path: path.join(OUT, 'b1-2-elk.png') });

  // 3) unsupported notice (a 'state' message), preview cleared
  await send(page, { type: 'state', kind: 'unsupported', text: 'Preview supports flowcharts. "sequenceDiagram" isn\'t supported in v1.' });
  await page.waitForTimeout(60);
  assert.ok(!(await page.locator('#state').evaluate((e) => e.classList.contains('hidden'))), '3) state visible for unsupported');
  assert.match(await page.locator('#state').innerText(), /isn't supported in v1/, '3) shows the unsupported text');
  assert.equal(await page.locator('#preview svg').count(), 0, '3) preview cleared on state');
  await page.screenshot({ path: path.join(OUT, 'b1-3-unsupported.png') });

  // 4) parse-error state — a malformed diagram shows the error, not a half-render
  await send(page, { type: 'render', code: 'graph TD\n  A --', id: 'm4', theme: 'dark' });
  r = await lastResult(page);
  assert.ok(!r.ok && r.error, '4) malformed diagram should report an error');
  assert.ok(!(await page.locator('#state').evaluate((e) => e.classList.contains('hidden'))), '4) error state visible');
  assert.equal(await page.locator('#preview svg').count(), 0, '4) no svg on parse error');
  await page.screenshot({ path: path.join(OUT, 'b1-4-error.png') });

  // CSP: with the locked policy there must be ZERO violations across all renders
  assert.equal(violations.length, 0, `CSP: expected 0 violations, got ${violations.length}: ${[...new Set(violations)].join(', ')}`);

  await browser.close();
  try { fs.unlinkSync(harnessFile); } catch {}
  console.log('B1 RENDER PASS: flowchart + ELK-frontmatter + unsupported-notice + parse-error, 0 CSP violations under the locked policy');
})().catch((e) => { console.error('B1 RENDER FAILED:', e); process.exit(1); });
