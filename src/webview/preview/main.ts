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
//   out: { type:'preview-ready' }            bundle loaded + ELK registered
//        { type:'rendered', ok, ms, error? } render result + timing
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
    drag = { x: e.clientX - tx, y: e.clientY - ty };
    vp.setPointerCapture(e.pointerId);
    vp.classList.add('grabbing');
  });
  vp.addEventListener('pointermove', (e) => {
    if (!drag) return;
    tx = e.clientX - drag.x;
    ty = e.clientY - drag.y;
    applyTransform();
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    vp.classList.remove('grabbing');
    try {
      vp.releasePointerCapture(e.pointerId);
    } catch {}
  };
  vp.addEventListener('pointerup', endDrag);
  vp.addEventListener('pointercancel', endDrag);

  const center = (factor) => {
    const r = vp.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, factor);
  };
  $('zoom-in').addEventListener('click', () => center(STEP));
  $('zoom-out').addEventListener('click', () => center(1 / STEP));
  $('fit').addEventListener('click', fit);
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
