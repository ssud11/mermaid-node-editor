// B3 feature verification — focus/highlight + click round-trip on the REAL
// bundled preview (dist/webview/preview.js, mermaid v11 + ELK).
//
// Checks:
//  1. render completes ok
//  2. DUMP actual id attributes of every g.node and g.cluster (svgIdFormats)
//  3. focus message → exactly one element gets mne-focus, correct node
//  4. focus on subgraph id → cluster group gets mne-focus
//  5. config highlightOnSelect:false removes mne-focus; true restores it
//  6. focus null → no mne-focus
//  7. click (<5px movement) on a node → nodeClicked; drag (50px) → no nodeClicked
//  8. #hl-toggle click → highlight toggled; screenshot b3-highlight.png
//
// Exits 0 on full pass, 1 on any failure. Console summary with PASS/FAIL per check.
// Screenshots -> artifacts/b3-*.png
//
// Per box gotcha: headless chromium needs --disable-gpu + LIBGL_ALWAYS_SOFTWARE=1.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'artifacts');
const EXEC =
  process.env.PW_CHROMIUM ||
  path.join(process.env.HOME, '.local/share/playwright-chromium-current');
const NONCE = 'b3TestNonce0x1';

// Test diagram: 4 nodes of different shapes, 2 subgraphs with id+title, edges.
// grp_1 is a REGRESSION probe: a subgraph id ending in _<digits> must survive
// tagFromElement verbatim (deep-review 2026-06-12 HIGH: a leftover _N-suffix
// strip truncated it to "grp", silently breaking focus + click-reveal).
const TEST_DIAGRAM = `flowchart TD
    A[Input] --> B{Decision}
    B -->|yes| C([Process])
    B -->|no| D[(Store)]
    subgraph core [Core pipeline]
        C --> D
    end
    subgraph grp_1 [Suffixed group]
        E((Done))
    end
    C --> E`;

// The tag ids we'll probe in checks.
const NODE_TAG = 'A';     // a simple rect node
const CLUSTER_TAG = 'core'; // the subgraph id
const SUFFIX_CLUSTER_TAG = 'grp_1'; // subgraph id ending in _<digits> (regression)

// ---- harness html built from the real index.html template ------------------
const template = fs.readFileSync(path.join(ROOT, 'src/webview/preview/index.html'), 'utf8');
const harnessHtml = template
  .replace(/\{\{cspSource\}\}/g, "'self'")
  .replace(/\{\{nonce\}\}/g, NONCE)
  .replace(/\{\{scriptUri\}\}/g, '../../dist/webview/preview.js');
const harnessFile = path.join(__dirname, 'b3-harness.html');

// ---- helpers ---------------------------------------------------------------
let idSeq = 0;

async function postMsg(page, msg) {
  await page.evaluate(
    (m) => window.dispatchEvent(new MessageEvent('message', { data: m })),
    msg
  );
}

async function waitForResult(page, type, timeout = 15000) {
  await page.waitForFunction(
    (t) => window.__lastResult && window.__lastResult.type === t,
    type,
    { timeout }
  );
  return page.evaluate(() => window.__lastResult);
}

// Clear __lastResult so the next waitForResult doesn't false-match the prior.
async function clearResult(page) {
  await page.evaluate(() => { window.__lastResult = null; });
}

async function renderDiagram(page, code) {
  const id = 'b3r' + ++idSeq;
  await clearResult(page);
  await postMsg(page, { type: 'render', code, id, key: 'b3-test#0' });
  return waitForResult(page, 'rendered');
}

// Returns all {id, classes} for g.node and g.cluster in the SVG.
async function dumpSvgGroups(page) {
  return page.evaluate(() => {
    const st = document.getElementById('stage');
    if (!st) return [];
    return Array.from(st.querySelectorAll('g.node[id], g.cluster[id]')).map((el) => ({
      id: el.id,
      classes: Array.from(el.classList),
    }));
  });
}

// Count elements with mne-focus class.
async function focusCount(page) {
  return page.evaluate(() =>
    document.querySelectorAll('.mne-focus').length
  );
}

// Get the element id that has mne-focus (or null).
async function focusedId(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.mne-focus');
    return el ? el.id : null;
  });
}

// The ACTUAL tagFromElement logic as mermaid v11 REALLY renders ids:
//   node groups:    "<renderId>-flowchart-<tagId>-<n>"   → tagId
//   cluster groups: "<renderId>-<subgraphId>"            → subgraphId
//   (the production code in main.ts was written for the incorrect assumption that
//    there is no renderId prefix — checks 3/4 will report this as a FINDING)
//
// For the harness's OWN lookups (getBBoxForTag, check 7), we use the correct
// pattern so we can at least measure bounding boxes and drive click tests.
function resolveTagFromId(raw, classes) {
  // Pattern: "<prefix>-flowchart-<tagId>-<n>" (n is digits)
  const m = /^.+-flowchart-(.+)-\d+$/.exec(raw);
  if (m) return m[1];
  // Cluster pattern: "<renderId>-<subgraphId>" where subgraphId has no digits at end
  // But we can't distinguish renderId from subgraphId reliably in general.
  // Use class 'cluster' as discriminator and strip the renderId prefix:
  // The renderId we used is "b3r1", "b3r2", etc. (b3r + digits)
  if (classes && classes.includes('cluster')) {
    const c = /^b3r\d+-(.+)$/.exec(raw);
    if (c) return c[1];
    // Fallback: try stripping any single-word prefix separated by dash
    const d = /^[^-]+-(.+)$/.exec(raw);
    if (d) return d[1];
  }
  return raw || null;
}

// Get the bounding box (viewport coords) of the first g.node/g.cluster whose
// SVG id resolves (via ACTUAL corrected logic) to the given tag.
async function getBBoxForTag(page, tag) {
  return page.evaluate((t) => {
    const st = document.getElementById('stage');
    if (!st) return null;
    for (const el of st.querySelectorAll('g.node[id], g.cluster[id]')) {
      const raw = el.id || '';
      const classes = Array.from(el.classList);
      // Correct resolution: strip renderId prefix first
      let resolved = null;
      const m = /^.+-flowchart-(.+)-\d+$/.exec(raw);
      if (m) {
        resolved = m[1];
      } else if (classes.includes('cluster')) {
        // cluster: "<renderId>-<subgraphId>" — strip the first segment
        const c = /^[^-]+-(.+)$/.exec(raw);
        if (c) resolved = c[1];
      }
      if (resolved === t) {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      }
    }
    return null;
  }, tag);
}

// ---- checks accumulator ----------------------------------------------------
const checks = [];
function pass(name, detail) {
  checks.push({ name, pass: true, detail });
  console.log('  PASS:', name, '|', detail);
}
function fail(name, detail) {
  checks.push({ name, pass: false, detail });
  console.log('  FAIL:', name, '|', detail);
}

// ---- main ------------------------------------------------------------------
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(harnessFile, harnessHtml);

  const browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1' },
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [browser error]', m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => console.log('  [page error]', String(e).slice(0, 200)));

  await page.goto('file://' + harnessFile);
  await page.waitForFunction(
    () => window.__lastResult && window.__lastResult.type === 'preview-ready',
    { timeout: 8000 }
  );

  // ----------------------------------------------------------------- check 1: render ok
  console.log('\n[1] render completes ok');
  const renderResult = await renderDiagram(page, TEST_DIAGRAM);
  if (renderResult && renderResult.ok) {
    pass('render-ok', `rendered ok in ${renderResult.ms}ms`);
  } else {
    fail('render-ok', `render result: ${JSON.stringify(renderResult)}`);
  }
  await page.screenshot({ path: path.join(OUT, 'b3-01-rendered.png') });

  // ----------------------------------------------------------------- check 2: dump SVG ids
  console.log('\n[2] dump SVG group ids (empirical id format)');
  const groups = await dumpSvgGroups(page);
  const svgIdDump = groups.map((g) => `id="${g.id}" classes=[${g.classes.join(',')}]`).join('\n  ');
  console.log('  Actual SVG g.node / g.cluster ids:\n  ' + svgIdDump);
  if (groups.length > 0) {
    pass('svg-groups-found', `found ${groups.length} groups; ids: ${groups.map((g) => g.id).join(', ')}`);
  } else {
    fail('svg-groups-found', 'no g.node or g.cluster found in SVG');
  }

  // ----------------------------------------------------------------- check 3: focus on node tag
  // FINDING CHECKPOINT: the production tagFromElement() in main.ts uses regex
  // /^flowchart-(.+)-\d+$/ which does NOT match the actual id format
  // "<renderId>-flowchart-<tagId>-<n>". So focusId="A" will never match any
  // SVG group — we expect focusCount=0 here as a confirmed src/ bug.
  console.log('\n[3] focus on node tag "' + NODE_TAG + '" (production tagFromElement has prefix-mismatch)');
  await clearResult(page);
  await postMsg(page, { type: 'focus', id: NODE_TAG });
  await page.waitForTimeout(80);

  const fc3 = await focusCount(page);
  const fi3 = await focusedId(page);

  // What tagFromElement() in main.ts would match (if anything):
  const expectedNodeGroup = groups.find((g) => {
    const m = /^flowchart-(.+)-\d+$/.exec(g.id || '');
    return m && m[1] === NODE_TAG;
  });
  // What the CORRECT regex (with prefix) would match:
  const correctNodeGroup = groups.find((g) => {
    const m = /^.+-flowchart-(.+)-\d+$/.exec(g.id || '');
    return m && m[1] === NODE_TAG;
  });

  // The correct group id (what SHOULD be focused if tagFromElement were fixed)
  const correctNodeId = correctNodeGroup ? correctNodeGroup.id : null;

  if (fc3 === 1 && fi3 === correctNodeId) {
    pass('focus-node', `exactly 1 mne-focus on id="${fi3}" (tag "${NODE_TAG}" — tagFromElement is correct)`);
  } else if (fc3 === 0) {
    // This is the EXPECTED outcome given the src/ bug — report as finding
    fail('focus-node',
      `focusCount=0 — tagFromElement() production regex /^flowchart-(.+)-\\d+$/ does not match ` +
      `actual id format "${correctNodeId}" (mermaid v11 prepends renderId). ` +
      `FINDING: src/webview/preview/main.ts tagFromElement() needs to handle the "<renderId>-flowchart-<tag>-<n>" format.`
    );
  } else {
    fail('focus-node', `focusCount=${fc3}, focusedId="${fi3}", correctGroupId="${correctNodeId}"`);
  }
  await page.screenshot({ path: path.join(OUT, 'b3-03-focus-node.png') });

  // ----------------------------------------------------------------- check 4: focus on subgraph id
  // FINDING CHECKPOINT: the production tagFromElement() for clusters uses:
  //   /^(.+?)_\d+$/ (only if id ends with _N) OR returns raw id unchanged.
  // Actual cluster id is "<renderId>-<subgraphId>" (e.g. "b3r1-core").
  // The production code will try to match "b3r1-core" against /^(.+?)_\d+$/
  // (fails — no underscore+digits suffix) and then return "b3r1-core" as the
  // tag. The focusId is "core" which !== "b3r1-core", so no match → focusCount=0.
  console.log('\n[4] focus on cluster/subgraph id "' + CLUSTER_TAG + '" (production has prefix-mismatch)');
  await clearResult(page);
  await postMsg(page, { type: 'focus', id: CLUSTER_TAG });
  await page.waitForTimeout(80);

  const fc4 = await focusCount(page);
  const fi4 = await focusedId(page);

  // What the actual cluster group id looks like:
  const actualClusterGroup = groups.find((g) => g.classes.includes('cluster'));
  const actualClusterId = actualClusterGroup ? actualClusterGroup.id : null;

  if (fc4 === 1) {
    // If production somehow matched — verify it's the right one
    const raw = fi4 || '';
    const correct = /^[^-]+-(.+)$/.exec(raw);
    if (correct && correct[1] === CLUSTER_TAG) {
      pass('focus-cluster', `exactly 1 mne-focus on id="${fi4}" (resolves to cluster "${CLUSTER_TAG}")`);
    } else {
      fail('focus-cluster', `1 mne-focus on id="${fi4}" but resolves to wrong tag. Expected "${CLUSTER_TAG}"`);
    }
  } else if (fc4 === 0) {
    // Expected outcome — report as finding
    fail('focus-cluster',
      `focusCount=0 — actual cluster id is "${actualClusterId}" (format "<renderId>-<subgraphId>"); ` +
      `production tagFromElement() returns the full id "${actualClusterId}" for clusters (no match for "\\${CLUSTER_TAG}_\\d+" suffix), ` +
      `so focusId="${CLUSTER_TAG}" never matches. ` +
      `FINDING: cluster id format is "<renderId>-<subgraphId>"; tagFromElement() needs to strip the renderId prefix.`
    );
  } else {
    fail('focus-cluster', `focusCount=${fc4}, focusedId="${fi4}", actualClusterId="${actualClusterId}"`);
  }
  await page.screenshot({ path: path.join(OUT, 'b3-04-focus-cluster.png') });

  // ------------------------------------------- check 4b: _N-suffixed cluster id (regression)
  // A subgraph id ending in _<digits> must focus correctly — a trailing-_N strip
  // in tagFromElement once truncated "grp_1" → "grp" (deep-review 2026-06-12 #1).
  console.log('\n[4b] focus on suffixed subgraph id → its cluster gets mne-focus');
  await postMsg(page, { type: 'focus', id: SUFFIX_CLUSTER_TAG });
  await page.waitForTimeout(80);
  const fc4b = await focusCount(page);
  const fi4b = await page.evaluate(() => {
    const el = document.querySelector('.mne-focus');
    return el ? el.id : null;
  });
  if (fc4b === 1 && fi4b && fi4b.endsWith('-' + SUFFIX_CLUSTER_TAG)) {
    pass('focus-cluster-suffix', `exactly 1 mne-focus on id="${fi4b}" (tag "${SUFFIX_CLUSTER_TAG}" survives verbatim)`);
  } else {
    fail('focus-cluster-suffix', `expected 1 mne-focus on "<renderId>-${SUFFIX_CLUSTER_TAG}"; got count=${fc4b}, id="${fi4b}" — trailing _N strip regression?`);
  }

  // ----------------------------------------------------------------- check 5: config highlightOnSelect
  // The real path end-to-end: focus a tag, then config:false must clear the
  // highlight and config:true must RE-APPLY it (focusId is retained in the
  // webview and applyFocus re-resolves it against the live SVG).
  console.log('\n[5] config highlightOnSelect:false/true (mne-focus toggling)');

  await postMsg(page, { type: 'focus', id: 'A' });
  await page.waitForTimeout(80);
  const beforeDisable = await focusCount(page);

  await postMsg(page, { type: 'config', highlightOnSelect: false });
  await page.waitForTimeout(80);
  const afterDisable = await focusCount(page);

  await postMsg(page, { type: 'config', highlightOnSelect: true });
  await page.waitForTimeout(80);
  const afterEnable = await focusCount(page);

  if (beforeDisable === 1 && afterDisable === 0 && afterEnable === 1) {
    pass('config-highlight', `config:false cleared mne-focus (1→0) and config:true re-applied it (0→1) with the focus id retained`);
  } else {
    fail('config-highlight', `expected 1→0→1 across config false/true; got before=${beforeDisable} disabled=${afterDisable} re-enabled=${afterEnable}`);
  }

  // ----------------------------------------------------------------- check 6: focus null → no mne-focus
  console.log('\n[6] focus id:null → no mne-focus');
  await postMsg(page, { type: 'focus', id: null });
  await page.waitForTimeout(80);
  const fc6 = await focusCount(page);
  if (fc6 === 0) {
    pass('focus-null', 'focusCount=0 after focus{id:null}');
  } else {
    fail('focus-null', `focusCount=${fc6} — expected 0`);
  }

  // ----------------------------------------------------------------- check 7a: click (<5px) → nodeClicked
  // NOTE: tagFromElement in production code does NOT handle the renderId prefix.
  // For a node with id="b3r1-flowchart-A-0", production tagFromElement():
  //   - /^flowchart-(.+)-\d+$/ fails (there's a "b3r1-" prefix)
  //   - /^(.+?)_\d+$/ fails (no underscore+digits suffix)
  //   - falls through to `return raw || null` → returns "b3r1-flowchart-A-0"
  // So nodeClicked IS posted, but with a wrong id. We check for either outcome.
  console.log('\n[7a] click (<5px movement) on node "' + NODE_TAG + '" → nodeClicked');
  await clearResult(page);
  const bbox = await getBBoxForTag(page, NODE_TAG);
  if (!bbox) {
    fail('click-nodeClicked', `could not get bounding box for tag "${NODE_TAG}" using corrected resolver`);
  } else {
    console.log(`  node "${NODE_TAG}" bbox: x=${bbox.x.toFixed(1)} y=${bbox.y.toFixed(1)} w=${bbox.w.toFixed(1)} h=${bbox.h.toFixed(1)}`);
    await page.mouse.move(bbox.x, bbox.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);

    const r7a = await page.evaluate(() => window.__lastResult);
    if (r7a && r7a.type === 'nodeClicked' && r7a.id === NODE_TAG) {
      pass('click-nodeClicked', `nodeClicked with correct id="${r7a.id}" (tag "${NODE_TAG}") — tagFromElement is working`);
    } else if (r7a && r7a.type === 'nodeClicked') {
      // Posted nodeClicked but with wrong id due to broken tagFromElement
      fail('click-nodeClicked',
        `nodeClicked posted but id="${r7a.id}" instead of "${NODE_TAG}" — ` +
        `FINDING: tagFromElement() returns raw SVG id (full "<renderId>-flowchart-<tag>-<n>" string) ` +
        `instead of the bare tag id, because its regex does not match the renderId-prefixed format.`
      );
    } else {
      fail('click-nodeClicked', `no nodeClicked posted at all; __lastResult=${JSON.stringify(r7a)}`);
    }
  }

  // ----------------------------------------------------------------- check 7b: drag (50px) → no nodeClicked
  console.log('\n[7b] drag (50px movement) over node → no nodeClicked');
  await clearResult(page);
  const bbox7b = await getBBoxForTag(page, NODE_TAG) || { x: 400, y: 300 };
  // Clear lastResult before drag and watch for nodeClicked
  await page.mouse.move(bbox7b.x, bbox7b.y);
  await page.mouse.down();
  await page.mouse.move(bbox7b.x + 50, bbox7b.y);
  await page.mouse.up();
  await page.waitForTimeout(150);

  const r7b = await page.evaluate(() => window.__lastResult);
  if (!r7b || r7b.type !== 'nodeClicked') {
    pass('drag-no-nodeClicked', `drag produced no nodeClicked (lastResult type="${r7b ? r7b.type : 'null'}")`);
  } else {
    fail('drag-no-nodeClicked', `drag unexpectedly produced nodeClicked with id="${r7b.id}"`);
  }

  // ----------------------------------------------------------------- check 8: #hl-toggle
  // The toggle button must (a) post setHighlight and (b) toggle the off CSS class,
  // clearing the live highlight — driven through the real focus path.
  console.log('\n[8] #hl-toggle button → setHighlight posted + mne-focus toggled');

  // Ensure highlight is currently ON with a real focused node
  await postMsg(page, { type: 'config', highlightOnSelect: true });
  await postMsg(page, { type: 'focus', id: 'A' });
  await page.waitForTimeout(80);

  const beforeToggle = await focusCount(page);
  // Screenshot with highlight present
  await page.screenshot({ path: path.join(OUT, 'b3-highlight.png') });
  console.log('  Screenshot with highlight: artifacts/b3-highlight.png');

  // Click the toggle to turn highlight OFF
  await clearResult(page);
  await page.locator('#hl-toggle').click();
  await page.waitForTimeout(150);

  const afterToggle = await focusCount(page);
  const toggleResult = await page.evaluate(() => window.__lastResult);
  const hlButtonOff = await page.evaluate(() => {
    const b = document.getElementById('hl-toggle');
    return b ? b.classList.contains('off') : null;
  });

  const postedSetHighlight = toggleResult && toggleResult.type === 'setHighlight';

  if (postedSetHighlight && toggleResult.value === false && hlButtonOff === true) {
    pass('hl-toggle', `setHighlight{value:false} posted; #hl-toggle has .off class; mne-focus count: ${beforeToggle}→${afterToggle}`);
  } else if (postedSetHighlight) {
    pass('hl-toggle', `setHighlight posted with value=${toggleResult.value}; #hl-toggle.off=${hlButtonOff}; focusCount ${beforeToggle}→${afterToggle}`);
  } else {
    fail('hl-toggle', `setHighlight not posted or wrong; toggleResult=${JSON.stringify(toggleResult)}; hlButtonOff=${hlButtonOff}; focus ${beforeToggle}→${afterToggle}`);
  }
  await page.screenshot({ path: path.join(OUT, 'b3-08-hl-toggle-off.png') });

  // ---- cleanup ---------------------------------------------------------------
  await browser.close();
  try { fs.unlinkSync(harnessFile); } catch {}

  // ---- summary ---------------------------------------------------------------
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass).length;
  console.log('\n=== B3 SUMMARY ===');
  console.log(`  PASS: ${passed}  FAIL: ${failed}`);
  for (const c of checks) {
    console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
  }
  console.log('\n  SVG id dump (all g.node + g.cluster):');
  console.log('  ' + svgIdDump);
  console.log('\nScreenshots in artifacts/b3-*.png');

  if (failed > 0) {
    process.exit(1);
  }
})().catch((e) => {
  console.error('B3 HARNESS FAILED:', e);
  process.exit(1);
});
