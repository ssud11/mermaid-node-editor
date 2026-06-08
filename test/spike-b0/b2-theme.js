// B2b theme-match verification — renders the same diagram under an injected
// DARK and LIGHT VS Code palette and asserts the mermaid node fill tracks the
// theme (i.e. readThemeVars() -> mermaid themeVariables actually wires up).
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'artifacts');
const EXEC = process.env.PW_CHROMIUM || path.join(process.env.HOME, '.local/share/playwright-chromium-current');
const NONCE = 'b2Nonce0x9';

const template = fs.readFileSync(path.join(ROOT, 'src/webview/preview/index.html'), 'utf8');
const harnessHtml = template
  .replace(/{{cspSource}}/g, "'self'")
  .replace(/{{nonce}}/g, NONCE)
  .replace(/{{scriptUri}}/g, '../../dist/webview/preview.js');
const harnessFile = path.join(__dirname, 'b2-harness.html');
const demo = fs.readFileSync(path.join(ROOT, 'examples/demo.mmd'), 'utf8');

// nodeBg maps to --vscode-editorWidget-background (distinctive values per theme)
const DARK = { '--vscode-foreground': '#cccccc', '--vscode-editor-background': '#1e1e1e', '--vscode-editorWidget-background': '#252526', '--vscode-panel-border': '#2b2b2b', '--vscode-sideBar-background': '#181818', '--vscode-descriptionForeground': '#9d9d9d' };
const LIGHT = { '--vscode-foreground': '#3b3b3b', '--vscode-editor-background': '#ffffff', '--vscode-editorWidget-background': '#f3f3f3', '--vscode-panel-border': '#e5e5e5', '--vscode-sideBar-background': '#f8f8f8', '--vscode-descriptionForeground': '#767676' };

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function renderWith(page, vars, id, shot) {
  await page.evaluate((v) => {
    for (const [k, val] of Object.entries(v)) document.documentElement.style.setProperty(k, val);
  }, vars);
  await page.evaluate((args) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'render', code: args.code, id: args.id } })), { code: demo, id });
  await page.waitForFunction(() => window.__lastResult && window.__lastResult.type === 'rendered' && window.__lastResult.ok, { timeout: 15000 });
  // Collect fills of actual NODE shapes (g.node), excluding subgraph clusters.
  const fills = await page.evaluate(() => {
    const out = [];
    for (const g of document.querySelectorAll('#preview svg g.node')) {
      const s = g.querySelector('rect, polygon, circle, path');
      if (s) out.push(getComputedStyle(s).fill);
    }
    return out;
  });
  await page.screenshot({ path: path.join(OUT, shot) });
  return fills;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(harnessFile, harnessHtml);
  const browser = await chromium.launch({ executablePath: EXEC, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto('file://' + harnessFile);
  await page.waitForFunction(() => window.__lastResult && window.__lastResult.type === 'preview-ready', { timeout: 8000 });

  const darkFills = await renderWith(page, DARK, 'd1', 'b2-theme-dark.png');
  const lightFills = await renderWith(page, LIGHT, 'l1', 'b2-theme-light.png');

  console.log(`dark node fills:  ${[...new Set(darkFills)].join(', ')}  (nodeBg ~${rgb('#252526')})`);
  console.log(`light node fills: ${[...new Set(lightFills)].join(', ')}  (nodeBg ~${rgb('#f3f3f3')})`);

  assert.ok(darkFills.includes(rgb('#252526')), 'a dark node should fill with --vscode-editorWidget-background (#252526)');
  assert.ok(lightFills.includes(rgb('#f3f3f3')), 'a light node should fill with --vscode-editorWidget-background (#f3f3f3)');
  assert.ok(!lightFills.includes(rgb('#252526')), 'light render must not reuse the dark node fill — theme actually switched');

  await browser.close();
  try { fs.unlinkSync(harnessFile); } catch {}
  console.log('B2 THEME PASS: mermaid node fill tracks the VS Code theme (dark vs light)');
})().catch((e) => { console.error('B2 THEME FAILED:', e); process.exit(1); });
