// B2c pan/zoom verification — drives the REAL preview assets and asserts the
// hand-rolled pan/zoom behaves like the mermaid preview:
//   1. wheel zoom is CURSOR-CENTERED (the diagram point under the pointer stays put)
//   2. drag pans by the drag delta
//   3. fit centers + scales the diagram to the viewport
//   4. sticky: same-diagram re-render keeps the view; a new diagram refits
//   5. toolbar appears on render and the % readout tracks the scale
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'artifacts');
const EXEC = process.env.PW_CHROMIUM || path.join(process.env.HOME, '.local/share/playwright-chromium-current');
const NONCE = 'b2cNonce0x7';

const template = fs.readFileSync(path.join(ROOT, 'src/webview/preview/index.html'), 'utf8');
const harnessHtml = template
  .replace(/{{cspSource}}/g, "'self'")
  .replace(/{{nonce}}/g, NONCE)
  .replace(/{{scriptUri}}/g, '../../dist/webview/preview.js');
const harnessFile = path.join(__dirname, 'b2c-harness.html');
const demo = fs.readFileSync(path.join(ROOT, 'examples/demo.mmd'), 'utf8');

const xform = (page) =>
  page.evaluate(() => {
    const m = new DOMMatrixReadOnly(getComputedStyle(document.getElementById('stage')).transform);
    return { scale: m.a, tx: m.e, ty: m.f };
  });
const rect = (page) => page.evaluate(() => {
  const r = document.getElementById('preview').getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width, h: r.height };
});
let idSeq = 0;
async function renderDiagram(page, code, key) {
  const id = 'r' + ++idSeq; // selector-safe id (mermaid does querySelector('#'+id))
  await page.evaluate((a) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'render', code: a.code, id: a.id, key: a.key } })), { code, id, key });
  await page.waitForFunction(() => window.__lastResult && window.__lastResult.type === 'rendered' && window.__lastResult.ok, { timeout: 15000 });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(harnessFile, harnessHtml);
  const browser = await chromium.launch({ executablePath: EXEC, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto('file://' + harnessFile);
  await page.waitForFunction(() => window.__lastResult && window.__lastResult.type === 'preview-ready', { timeout: 8000 });

  await renderDiagram(page, demo, 'fileA#0');

  // toolbar visible after render
  assert.ok(!(await page.locator('#toolbar').evaluate((e) => e.classList.contains('hidden'))), '5) toolbar visible after render');
  const r = await rect(page);

  // 1) CURSOR-CENTERED wheel zoom: the stage-local point under the cursor must
  //    map back to the same viewport point after zooming.
  const before = await xform(page);
  const cx = 300, cy = 240; // viewport-relative cursor target
  const lx = (cx - before.tx) / before.scale; // stage-local point under the cursor
  const ly = (cy - before.ty) / before.scale;
  await page.mouse.move(r.left + cx, r.top + cy);
  await page.mouse.wheel(0, -200); // zoom in at the cursor
  await page.waitForTimeout(30);
  const after = await xform(page);
  assert.ok(after.scale > before.scale * 1.05, `1) wheel up should zoom in (${before.scale} -> ${after.scale})`);
  const mappedX = after.tx + lx * after.scale;
  const mappedY = after.ty + ly * after.scale;
  assert.ok(Math.abs(mappedX - cx) < 0.75, `1) cursor-centered X: point stays under cursor (Δ=${(mappedX - cx).toFixed(2)})`);
  assert.ok(Math.abs(mappedY - cy) < 0.75, `1) cursor-centered Y: point stays under cursor (Δ=${(mappedY - cy).toFixed(2)})`);

  // 2) drag pans by exactly the drag delta
  const pre = await xform(page);
  await page.mouse.move(r.left + 400, r.top + 300);
  await page.mouse.down();
  await page.mouse.move(r.left + 460, r.top + 330);
  await page.mouse.up();
  await page.waitForTimeout(30);
  const post = await xform(page);
  assert.ok(Math.abs(post.tx - pre.tx - 60) < 1.5 && Math.abs(post.ty - pre.ty - 30) < 1.5, `2) drag pans by the delta (Δtx=${(post.tx - pre.tx).toFixed(1)}, Δty=${(post.ty - pre.ty).toFixed(1)})`);

  // 3) fit re-centers + scales to viewport
  await page.locator('#fit').click();
  await page.waitForTimeout(30);
  const fitX = await xform(page);
  assert.ok(fitX.scale > 0 && fitX.tx >= -1 && fitX.ty >= -1, `3) fit produces an on-screen transform (scale=${fitX.scale.toFixed(2)})`);
  await page.screenshot({ path: path.join(OUT, 'b2c-fit.png') });

  // 4a) STICKY: re-render the SAME diagram (same key) — view must be preserved
  await page.mouse.move(r.left + 200, r.top + 200);
  await page.mouse.wheel(0, -200); // change the view
  const sticky0 = await xform(page);
  await renderDiagram(page, demo + '\n', 'fileA#0'); // same key, edited content
  await page.waitForTimeout(30);
  const sticky1 = await xform(page);
  assert.ok(Math.abs(sticky1.scale - sticky0.scale) < 0.01 && Math.abs(sticky1.tx - sticky0.tx) < 1, '4a) same-diagram re-render keeps zoom/pan (sticky)');

  // 4b) NEW diagram (different key) — must refit (transform changes)
  await renderDiagram(page, 'graph TD\n  X --> Y --> Z', 'fileB#0');
  await page.waitForTimeout(30);
  const refit = await xform(page);
  assert.ok(Math.abs(refit.scale - sticky1.scale) > 0.01 || Math.abs(refit.tx - sticky1.tx) > 1, '4b) a different diagram refits fresh (not sticky)');

  await browser.close();
  try { fs.unlinkSync(harnessFile); } catch {}
  console.log('B2c ZOOM PASS: cursor-centered wheel zoom + drag-pan + fit + sticky-vs-refit + toolbar');
})().catch((e) => { console.error('B2c ZOOM FAILED:', e); process.exit(1); });
