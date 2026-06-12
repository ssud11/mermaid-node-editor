// @ts-nocheck
// Phase B (v1.2) live-preview renderer — runs INSIDE the preview webview.
//
// Bundled by esbuild (browser/IIFE) into dist/webview/preview.js with the real
// `mermaid` library + the ELK layout engine inlined. This is the ONE place the
// project's "zero runtime deps" invariant intentionally ends.
//
// Contract (extension <-> webview):
//   in : { type:'render', code, id, key }   render a mermaid block
//        { type:'state',  kind, text }       show empty / unsupported notice
//        { type:'focus',  id }               highlight a tag's node (null = none)
//        { type:'config', highlightOnSelect } apply the highlight setting
//   out: { type:'preview-ready' }            bundle loaded + ELK registered
//        { type:'rendered', ok, ms, error? } render result + timing
//        { type:'nodeClicked', id }          a node/cluster was clicked (B3)
//        { type:'setHighlight', value }      toolbar toggle → persist the setting
//
// Pan/zoom is hand-rolled (zero dep, CSP-clean) per the B0 research: cursor-
// centered wheel zoom + drag-pan + fit/reset + sticky across re-render. One CSS
// transform on #stage; mermaid renders into #stage; #preview is the clip viewport.
import mermaid from 'mermaid';
import elkLayouts from '@mermaid-js/layout-elk';

// THE elk line: register the external ELK layout loader so a diagram with
// `config: { layout: elk }` resolves instead of erroring "unknown layout".
mermaid.registerLayoutLoaders(elkLayouts);

const vscode =
  typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : undefined;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- theme ------
// Map VS Code theme colors -> mermaid `base` themeVariables so the diagram
// blends with the editor (any theme). Read fresh per render — VS Code updates
// these CSS vars in place when the theme changes.
function readThemeVars() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
  const fg = v('--vscode-foreground', '#cccccc');
  const bg = v('--vscode-editor-background', '#1e1e1e');
  const nodeBg = v('--vscode-editorWidget-background', v('--vscode-input-background', '#252526'));
  const border = v('--vscode-panel-border', v('--vscode-input-border', '#3c3c3c'));
  const clusterBg = v('--vscode-sideBar-background', bg);
  const line = v('--vscode-descriptionForeground', fg);
  const font = v('--vscode-font-family', 'sans-serif');
  return {
    background: bg,
    primaryColor: nodeBg,
    mainBkg: nodeBg,
    primaryBorderColor: border,
    nodeBorder: border,
    primaryTextColor: fg,
    nodeTextColor: fg,
    textColor: fg,
    titleColor: fg,
    lineColor: line,
    secondaryColor: clusterBg,
    tertiaryColor: clusterBg,
    clusterBkg: clusterBg,
    clusterBorder: border,
    edgeLabelBackground: bg,
    fontFamily: font,
  };
}

function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict', // trusted-local content; strict sanitizes labels
    theme: 'base',
    themeVariables: readThemeVars(),
    // htmlLabels:false (TOP-LEVEL — the flowchart.* key alone was ignored) → labels
    // become native SVG <text> that mermaid measures and wraps itself, instead of
    // HTML <foreignObject> whose wrapping silently failed in the VS Code webview
    // (it works in headless chromium — an environment-specific foreignObject quirk).
    htmlLabels: false,
    flowchart: { htmlLabels: false, wrappingWidth: 200 },
  });
}

// ------------------------------------------------------------- highlight -----
// B3: source→preview focus. The extension sends the tag id under the source
// cursor; we find its SVG group and toggle .mne-focus. State lives here so it
// re-applies after every render (the SVG is replaced wholesale each time).
let focusId = null;
let highlightOn = true;

// The renderId of the SVG currently in the DOM — mermaid v11 prepends it to
// every group id (empirically: nodes "<renderId>-flowchart-<tagId>-<n>",
// clusters "<renderId>-<subgraphId>"; confirmed by test/visual/preview-b3.js).
let lastRenderId = '';

// Map an SVG group's id back to our tag id: strip the exact renderId prefix we
// passed to mermaid.render(), then parse. Parsing the element id (instead of
// querySelector with an interpolated id) sidesteps CSS-escaping of arbitrary
// tag ids.
function tagFromElement(el) {
  let raw = el.id || '';
  if (lastRenderId && raw.startsWith(lastRenderId + '-')) raw = raw.slice(lastRenderId.length + 1);
  const m = /^flowchart-(.+)-\d+$/.exec(raw);
  if (m) return m[1];
  // Clusters: after the prefix strip, raw IS the verbatim subgraph id — no
  // further parsing (a trailing-_N strip here would corrupt ids like "grp_1").
  return raw || null;
}

function findElForTag(id) {
  const st = $('stage');
  if (!st) return null;
  for (const el of st.querySelectorAll('g.node[id], g.cluster[id]')) {
    if (tagFromElement(el) === id) return el;
  }
  return null;
}

function applyFocus() {
  const st = $('stage');
  if (!st) return;
  const current = st.querySelectorAll('.mne-focus');
  if (highlightOn && focusId) {
    const el = findElForTag(focusId);
    if (!el && current.length) {
      // No match for the (new) focus id in the CURRENT svg — e.g. a rename just
      // re-pointed the focus but the debounced re-render hasn't landed yet, so
      // the svg still carries the old id. Keep the existing highlight; the
      // post-render applyFocus() re-resolves against the fresh svg. (Focus ids
      // are validated against the block extension-side, so a no-match is always
      // this transient state, never a genuinely wrong tag.)
      return;
    }
    for (const c of current) c.classList.remove('mne-focus');
    if (el) el.classList.add('mne-focus');
    return;
  }
  for (const c of current) c.classList.remove('mne-focus');
}

function updateHlButton() {
  const b = $('hl-toggle');
  if (!b) return;
  b.classList.toggle('off', !highlightOn);
  b.setAttribute('aria-pressed', String(highlightOn));
  b.title = highlightOn ? 'Highlight selected node: on' : 'Highlight selected node: off';
}

function setHighlightOn(value) {
  highlightOn = value;
  updateHlButton();
  applyFocus();
}

// -------------------------------------------------------------- pan/zoom -----
const MIN = 0.1;
const MAX = 8;
const STEP = 1.15;
let scale = 1;
let tx = 0;
let ty = 0;
let drag = null;

const clamp = (s) => Math.min(MAX, Math.max(MIN, s));

function applyTransform() {
  const st = $('stage');
  if (st) st.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  const pct = $('zoom-pct');
  if (pct) pct.textContent = Math.round(scale * 100) + '%';
}

// Zoom anchored at a viewport point (cx,cy): the diagram point under it stays put.
function zoomAt(cx, cy, factor) {
  const next = clamp(scale * factor);
  const k = next / scale;
  tx = cx - (cx - tx) * k;
  ty = cy - (cy - ty) * k;
  scale = next;
  applyTransform();
}

// Intrinsic diagram size from the SVG viewBox (independent of CSS constraints).
function svgSize(svg) {
  const vb = svg.viewBox && svg.viewBox.baseVal;
  if (vb && vb.width && vb.height) return { w: vb.width, h: vb.height };
  const r = svg.getBoundingClientRect();
  return { w: r.width || 1, h: r.height || 1 };
}

function fit() {
  const vp = $('preview');
  const svg = $('stage') && $('stage').querySelector('svg');
  if (!vp || !svg) return;
  const { w, h } = svgSize(svg);
  const r = vp.getBoundingClientRect();
  const pad = 24;
  scale = clamp(Math.min((r.width - pad) / w, (r.height - pad) / h));
  tx = (r.width - w * scale) / 2;
  ty = (r.height - h * scale) / 2;
  applyTransform();
}

function setupInteraction() {
  const vp = $('preview');
  if (!vp || vp.__wired) return;
  vp.__wired = true;

  vp.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? STEP : 1 / STEP);
    },
    { passive: false }
  );

  vp.addEventListener('pointerdown', (e) => {
    // Record the pre-capture target: pointer capture retargets every later event
    // (including click) to #preview, so this is the only reliable "what was
    // under the pointer" for the click-vs-drag decision in endDrag.
    drag = { x: e.clientX - tx, y: e.clientY - ty, sx: e.clientX, sy: e.clientY, target: e.target };
    vp.setPointerCapture(e.pointerId);
    vp.classList.add('grabbing');
  });
  vp.addEventListener('pointermove', (e) => {
    if (!drag) return;
    tx = e.clientX - drag.x;
    ty = e.clientY - drag.y;
    applyTransform();
  });
  const endDrag = (e, cancelled) => {
    if (!drag) return;
    const moved = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy);
    const target = drag.target;
    drag = null;
    vp.classList.remove('grabbing');
    try {
      vp.releasePointerCapture(e.pointerId);
    } catch {}
    // B3: a press that barely moved is a click — if it landed on a node or
    // cluster, ask the extension to reveal it in the source. Click-reveal is
    // independent of the highlight toggle (an explicit click is navigation).
    // 10px threshold (not the usual ~5): over remote desktop (xrdp/RDP) pointer
    // jitter between press and release regularly exceeds 5px on a sincere click,
    // which silently classified clicks as pans (operator-reproduced 2026-06-12).
    if (!cancelled && moved < 10 && target && typeof target.closest === 'function') {
      const g = target.closest('g.node, g.cluster');
      if (g) {
        const id = tagFromElement(g);
        if (id) post({ type: 'nodeClicked', id });
      }
    }
  };
  vp.addEventListener('pointerup', (e) => endDrag(e, false));
  vp.addEventListener('pointercancel', (e) => endDrag(e, true));

  const center = (factor) => {
    const r = vp.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, factor);
  };
  $('zoom-in').addEventListener('click', () => center(STEP));
  $('zoom-out').addEventListener('click', () => center(1 / STEP));
  $('fit').addEventListener('click', fit);
  // Highlight toggle: flip locally for instant feedback, then persist through the
  // extension (the setting echoes back via a 'config' message — idempotent). The
  // local flip also keeps the button live in the vscode-less test harness.
  $('hl-toggle').addEventListener('click', () => {
    setHighlightOn(!highlightOn);
    post({ type: 'setHighlight', value: highlightOn });
  });
}

// ---------------------------------------------------------------- render -----
let seq = 0;
let lastKey = null;
// Monotonic render generation: renders are async (esp. ELK layout), so a newer
// render must be able to discard an older one's late completion — otherwise a
// slow earlier diagram can overwrite the diagram that's actually current.
let renderGen = 0;

function showState(text, isError) {
  const s = $('state');
  if (s) {
    s.textContent = text;
    s.classList.toggle('err', !!isError);
    s.classList.remove('hidden');
  }
  const st = $('stage');
  if (st) st.replaceChildren();
  const tb = $('toolbar');
  if (tb) tb.classList.add('hidden');
}

function clearState() {
  const s = $('state');
  if (s) s.classList.add('hidden');
}

async function render(code, id, key) {
  const gen = ++renderGen;
  initMermaid(); // re-read theme vars each render so a VS Code theme switch applies
  clearState();
  const st = $('stage');
  const renderId = id || 'm' + ++seq;
  const t0 = performance.now();
  try {
    await mermaid.parse(code); // validate first — never half-render a bad diagram
    // Fix attempt: mermaid measures text to size nodes; if the webview font isn't
    // loaded yet, measurement is too small and labels overflow/clip. Wait first.
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
      if (gen !== renderGen) return;
    }
    const { svg, bindFunctions } = await mermaid.render(renderId, code);
    if (gen !== renderGen) return; // a newer render started while we awaited — drop this stale result
    st.innerHTML = svg;
    lastRenderId = renderId; // the ids in THIS svg carry this prefix (set post-gen-guard)
    const svgEl = st.querySelector('svg');
    if (svgEl) {
      // render at intrinsic px size so the zoom math is 1:1 with screen pixels
      svgEl.style.maxWidth = 'none';
      const { w, h } = svgSize(svgEl);
      svgEl.setAttribute('width', w);
      svgEl.setAttribute('height', h);
    }
    if (bindFunctions && svgEl) bindFunctions(st);
    const tb = $('toolbar');
    if (tb) tb.classList.remove('hidden');
    // Sticky: re-rendering the SAME diagram (live edit) keeps the user's
    // zoom/pan; a NEW diagram fits fresh to the viewport.
    if (key && key === lastKey) {
      applyTransform();
    } else {
      fit();
    }
    lastKey = key || null;
    applyFocus(); // the render replaced the SVG — re-apply the focus highlight
    post({ type: 'rendered', ok: true, ms: Math.round(performance.now() - t0), hasSvg: !!svgEl });
  } catch (err) {
    if (gen !== renderGen) return; // a newer render superseded this one — drop the stale error
    const message = err && err.message ? err.message : String(err);
    showState(message, true);
    post({ type: 'rendered', ok: false, ms: Math.round(performance.now() - t0), error: message });
  }
}

function post(msg) {
  vscode?.postMessage(msg);
  // Spike/test hook: expose the last result for a headless driver to read.
  window.__lastResult = msg;
  window.dispatchEvent(new CustomEvent('preview-result', { detail: msg }));
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'render') {
    render(String(msg.code), msg.id, msg.key);
  } else if (msg.type === 'focus') {
    focusId = msg.id || null;
    applyFocus();
  } else if (msg.type === 'config') {
    setHighlightOn(msg.highlightOnSelect !== false);
  } else if (msg.type === 'state') {
    // A state message supersedes any in-flight render (e.g. unsupported notice).
    renderGen++;
    showState(String(msg.text || ''), false);
    // Only a genuine context change ('empty' — cursor left all diagrams) should
    // refit the next diagram. An 'unsupported' glance keeps the tracked diagram's
    // sticky key so returning to it preserves the user's zoom/pan.
    if (msg.kind === 'empty') lastKey = null;
    post({ type: 'rendered', ok: true, ms: 0, state: msg.kind });
  }
});

setupInteraction();
post({ type: 'preview-ready' });
