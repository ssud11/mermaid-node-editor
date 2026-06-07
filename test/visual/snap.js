// IT-1/IT-3 visual harness — renders the REAL webview (style.css + main.js) in
// chromium via playwright-core, feeds sample data, screenshots light + dark, and
// asserts the DOM renders correctly (incl. no markup injection from labels/ids).
//
// Reuses this box's already-installed chromium (no download). Per gotcha-bank
// Gotcha 30 (xrdp iGPU): run headless with --disable-gpu and LIBGL_ALWAYS_SOFTWARE=1.
// Output PNGs -> artifacts/ (gitignored), for the operator's gate review.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright-core');

const HARNESS = 'file://' + path.resolve(__dirname, 'harness.html');
const OUT = path.resolve(__dirname, '../../artifacts');
const EXEC =
  process.env.PW_CHROMIUM ||
  path.join(process.env.HOME, '.local/share/playwright-chromium-current');

// Representative VS Code theme variables (Dark Modern / Light Modern).
const COMMON = {
  '--vscode-font-family': '-apple-system, "Segoe UI", system-ui, sans-serif',
  '--vscode-font-size': '13px',
  '--vscode-editor-font-family': '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
};
const DARK = {
  ...COMMON,
  '--vscode-foreground': '#cccccc',
  '--vscode-editor-background': '#1e1e1e',
  '--vscode-sideBar-background': '#181818',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-editorWidget-background': '#252526',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-input-background': '#313131',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-inputValidation-errorBackground': '#5a1d1d',
  '--vscode-inputValidation-errorBorder': '#be1100',
  '--vscode-badge-background': '#616161',
  '--vscode-badge-foreground': '#ffffff',
};
const LIGHT = {
  ...COMMON,
  '--vscode-foreground': '#3b3b3b',
  '--vscode-editor-background': '#ffffff',
  '--vscode-sideBar-background': '#f8f8f8',
  '--vscode-descriptionForeground': '#767676',
  '--vscode-panel-border': '#e5e5e5',
  '--vscode-editorWidget-background': '#f3f3f3',
  '--vscode-input-foreground': '#616161',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-border': '#cecece',
  '--vscode-focusBorder': '#0090f1',
  '--vscode-inputValidation-errorBackground': '#fdf3f3',
  '--vscode-inputValidation-errorBorder': '#e51400',
  '--vscode-badge-background': '#c4c4c4',
  '--vscode-badge-foreground': '#3b3b3b',
};

const SAMPLE = {
  startLine: 0,
  diagramType: 'flowchart',
  supported: true,
  fileName: 'demo.mmd',
  nodes: [
    { id: 'A', label: 'Start', outgoing: ['B'], incoming: [] },
    { id: 'B', label: 'Is it valid?', outgoing: ['C', 'D'], incoming: ['A'] },
    { id: 'C', label: 'Process', outgoing: ['E'], incoming: ['B'] },
    { id: 'D', label: 'Reject', outgoing: [], incoming: ['B'] },
    // label + a connection id carrying HTML metachars — must render as text:
    { id: 'E', label: '<b>End</b>', outgoing: [], incoming: ['C', '<img src=x>'] },
  ],
  subgraphs: [{ id: 'flow', label: 'Validation', editable: true }],
  edgeCount: 5,
  warnings: [
    { id: 'C', message: 'Tag "C" is defined more than once with different labels — Mermaid merges them into one node.' },
  ],
};
const UNSUPPORTED = {
  startLine: 0,
  diagramType: 'sequenceDiagram',
  supported: false,
  fileName: 'demo.mmd',
  nodes: [],
  subgraphs: [],
  edgeCount: 0,
  warnings: [],
};

async function setTheme(page, vars) {
  await page.evaluate((v) => {
    for (const [k, val] of Object.entries(v)) document.documentElement.style.setProperty(k, val);
    document.body.style.background = 'var(--vscode-editor-background)';
  }, vars);
}

async function feed(page, message) {
  await page.evaluate((msg) => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  }, message);
}

async function shot(page, theme, name, message) {
  await page.goto(HARNESS);
  await setTheme(page, theme);
  if (message) await feed(page, message);
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 340, height: 640 } });

  await shot(page, DARK, '01-populated-dark.png', { type: 'update', block: SAMPLE, focusedId: 'A' });
  await shot(page, LIGHT, '02-populated-light.png', { type: 'update', block: SAMPLE, focusedId: 'A' });
  await shot(page, DARK, '03-unsupported-dark.png', { type: 'update', block: UNSUPPORTED });
  await shot(page, DARK, '04-empty-dark.png', { type: 'clear' });

  // --- assertions on the populated state (A selected -> its detail is open) ---
  await page.goto(HARNESS);
  await setTheme(page, DARK);
  await feed(page, { type: 'update', block: SAMPLE, focusedId: 'A' });
  await page.waitForTimeout(80);

  // master list: one row per node (compact rows scale to large diagrams)
  assert.ok((await page.locator('.row').count()) >= 5, 'a compact row should render per node');

  // filter box present
  assert.strictEqual(await page.locator('input.search').count(), 1, 'a filter box should render');

  // the selected node's detail shows its editable label input
  const startCount = await page.locator('input[value="Start"]').count();
  assert.ok(startCount >= 1, 'the selected node detail should show its label input ("Start")');

  // injection-safety: a label/id carrying HTML must render as text, never elements
  const injectedEls = await page.locator('b, img').count();
  assert.strictEqual(injectedEls, 0, 'labels/ids with HTML must render as text, not elements');

  // duplicate-tag warning badge on the flagged row
  assert.ok((await page.locator('.row-warn').count()) >= 1, 'a duplicate-tag row should show a warning badge');

  // innerText reflects CSS text-transform:uppercase, so match case-insensitively.
  const sectionText = await page.locator('.section-title').first().innerText();
  assert.ok(/nodes \(5\)/i.test(sectionText), 'should show "Nodes (5)" section title');

  // filtering narrows the visible rows
  await page.locator('input.search').fill('Reject');
  await page.waitForTimeout(50);
  assert.strictEqual(await page.locator('.row:visible').count(), 1, 'filter "Reject" should show exactly the D row');

  // unsupported notice
  await feed(page, { type: 'update', block: UNSUPPORTED });
  await page.waitForTimeout(80);
  const body = await page.locator('body').innerText();
  assert.ok(/not supported in v1/.test(body), 'unsupported diagram should show the v1 notice');

  // --- #3 regression: a rejected edit must show an error that is NOT instantly
  //     wiped, and must reset the field to canonical. The contract is a single
  //     {type:'error', message, block} message. The edited row stays selected so
  //     its detail re-renders from the canonical block. ---
  await page.goto(HARNESS);
  await setTheme(page, DARK);
  await feed(page, { type: 'update', block: SAMPLE, focusedId: 'B' }); // select B, detail open
  await page.waitForTimeout(40);
  await feed(page, { type: 'error', message: 'Id "C" already exists in this diagram.', block: SAMPLE });
  await page.waitForTimeout(80);
  assert.ok(await page.locator('#error').isVisible(), 'error box must be visible after a rejected edit');
  const errText = await page.locator('#error').innerText();
  assert.ok(/already exists/.test(errText), 'error box should show the rejection reason');
  assert.ok(
    (await page.locator('input[value="B"]').count()) >= 1,
    'the id field must reset to canonical (B) from the block carried with the error'
  );
  await page.screenshot({ path: path.join(OUT, '05-rejected-edit-dark.png'), fullPage: true });
  // A subsequent successful update clears the error (no regression of error-clearing).
  await feed(page, { type: 'update', block: SAMPLE, focusedId: 'B' });
  await page.waitForTimeout(80);
  assert.ok(!(await page.locator('#error').isVisible()), 'a successful update should clear the error');

  // --- deep-review #6: a passive refresh must NOT tear down a detail field the
  //     user is mid-edit in (it would drop the uncommitted value). ---
  await page.goto(HARNESS);
  await setTheme(page, DARK);
  await feed(page, { type: 'update', block: SAMPLE, focusedId: 'A' }); // A detail open
  await page.waitForTimeout(40);
  const aLabel = page.locator('.row-detail input').nth(1); // A's Label field
  await aLabel.click();
  await aLabel.fill('Edited-not-committed'); // focused, NOT blurred (no commit)
  await feed(page, { type: 'update', block: SAMPLE }); // passive external refresh
  await page.waitForTimeout(60);
  assert.strictEqual(
    await aLabel.inputValue(),
    'Edited-not-committed',
    'an in-progress detail edit must survive a passive refresh'
  );

  await browser.close();
  console.log('VISUAL PASS: 5 screenshots + DOM assertions (master-detail rows, filter, warning badge, no injection, unsupported, error-persist+reset)');
})().catch((err) => {
  console.error('Visual harness failed:', err);
  process.exit(1);
});
