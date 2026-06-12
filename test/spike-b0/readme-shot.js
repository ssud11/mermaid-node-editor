// Generate a clean static preview screenshot for the README, by rendering the
// shipped examples/demo.mmd through the real preview bundle (dark VS Code theme).
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const EXEC = process.env.PW_CHROMIUM || path.join(process.env.HOME, '.local/share/playwright-chromium-current');
const NONCE = 'readme0x1';
const template = fs.readFileSync(path.join(ROOT, 'src/webview/preview/index.html'), 'utf8');
const html = template.replace(/{{cspSource}}/g, "'self'").replace(/{{nonce}}/g, NONCE).replace(/{{scriptUri}}/g, '../../dist/webview/preview.js');
const harnessFile = path.join(__dirname, 'readme-harness.html');
const code = fs.readFileSync(path.join(ROOT, 'examples/demo.mmd'), 'utf8');
const OUT = path.join(ROOT, 'images', 'preview-dark.png');

const DARK = { '--vscode-foreground': '#cccccc', '--vscode-editor-background': '#1e1e1e', '--vscode-editorWidget-background': '#252526', '--vscode-panel-border': '#3c3c3c', '--vscode-sideBar-background': '#181818', '--vscode-descriptionForeground': '#9d9d9d', '--vscode-font-family': 'system-ui, Ubuntu, "Droid Sans", sans-serif' };

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(harnessFile, html);
  const browser = await chromium.launch({ executablePath: EXEC, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 720, height: 540 }, deviceScaleFactor: 2 });
  await page.goto('file://' + harnessFile);
  await page.waitForFunction(() => window.__lastResult && window.__lastResult.type === 'preview-ready', { timeout: 8000 });
  await page.evaluate((v) => { for (const [k, val] of Object.entries(v)) document.documentElement.style.setProperty(k, val); }, DARK);
  await page.evaluate((c) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'render', code: c, id: 'r', key: 'r#0' } })), code);
  await page.waitForFunction(() => window.__lastResult && window.__lastResult.type === 'rendered' && window.__lastResult.ok, { timeout: 15000 });
  await page.waitForTimeout(120);
  await page.screenshot({ path: OUT });
  await browser.close();
  try { fs.unlinkSync(harnessFile); } catch {}
  console.log('wrote ' + OUT);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
