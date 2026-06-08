// @ts-nocheck
// Phase B (v1.2) live-preview renderer — B0 spike seed.
//
// Bundled by esbuild (browser/IIFE) into dist/webview/preview.js with the real
// `mermaid` library + the ELK layout engine inlined. This is the ONE place the
// project's "zero runtime deps" invariant intentionally ends (B0 GO/NO-GO).
//
// Contract (webview <-> extension):
//   in : { type:'render', code, id, theme }   render a mermaid block
//        { type:'init',   theme }              (re)initialize the theme
//   out: { type:'preview-ready' }              bundle loaded + ELK registered
//        { type:'rendered', ok, ms, error? }   render result + timing
import mermaid from 'mermaid';
import elkLayouts from '@mermaid-js/layout-elk';

// THE elk feasibility line: register the external ELK layout loader so a diagram
// with `config: { layout: elk }` resolves instead of erroring "unknown layout".
mermaid.registerLayoutLoaders(elkLayouts);

const vscode =
  typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : undefined;

let initialized = false;
function init(theme) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict', // trusted-local content; strict is the safe default
    theme: theme === 'light' ? 'default' : 'dark',
    flowchart: { htmlLabels: true },
  });
  initialized = true;
}

async function render(code, id, theme) {
  if (!initialized) init(theme);
  const host = document.getElementById('preview');
  const t0 = performance.now();
  try {
    const { svg, bindFunctions } = await mermaid.render(id || 'mmd', code);
    host.innerHTML = svg;
    const svgEl = host.querySelector('svg');
    if (bindFunctions && svgEl) bindFunctions(host);
    post({ type: 'rendered', ok: true, ms: Math.round(performance.now() - t0), hasSvg: !!svgEl });
  } catch (err) {
    host.textContent = String(err && err.message ? err.message : err);
    post({ type: 'rendered', ok: false, ms: Math.round(performance.now() - t0), error: String(err) });
  }
}

function post(msg) {
  vscode?.postMessage(msg);
  // Spike-harness hook: expose the last result for the Playwright driver to read.
  window.__lastResult = msg;
  window.dispatchEvent(new CustomEvent('preview-result', { detail: msg }));
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') init(msg.theme);
  if (msg.type === 'render') render(String(msg.code), msg.id, msg.theme);
});

post({ type: 'preview-ready' });
