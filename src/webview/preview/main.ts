// @ts-nocheck
// Phase B (v1.2) live-preview renderer — runs INSIDE the preview webview.
//
// Bundled by esbuild (browser/IIFE) into dist/webview/preview.js with the real
// `mermaid` library + the ELK layout engine inlined. This is the ONE place the
// project's "zero runtime deps" invariant intentionally ends.
//
// Contract (extension <-> webview):
//   in : { type:'render', code, id, theme }   render a mermaid block
//        { type:'state',  kind, text }         show empty / unsupported notice
//   out: { type:'preview-ready' }              bundle loaded + ELK registered
//        { type:'rendered', ok, ms, error? }   render result + timing
import mermaid from 'mermaid';
import elkLayouts from '@mermaid-js/layout-elk';

// THE elk line: register the external ELK layout loader so a diagram with
// `config: { layout: elk }` resolves instead of erroring "unknown layout".
mermaid.registerLayoutLoaders(elkLayouts);

const vscode =
  typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : undefined;

const host = () => document.getElementById('preview');
const stateEl = () => document.getElementById('state');

let currentTheme = null;
function ensureInit(theme) {
  const t = theme === 'light' ? 'default' : 'dark';
  if (currentTheme === t) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict', // trusted-local content; strict sanitizes labels
    theme: t,
    flowchart: { htmlLabels: true },
  });
  currentTheme = t;
}

// A monotonic fallback id: mermaid.render() injects a <style> keyed by id, so a
// reused id leaks/duplicates style blocks — never reuse one.
let seq = 0;

function showState(text) {
  const s = stateEl();
  if (s) {
    s.textContent = text;
    s.classList.remove('hidden');
  }
  const h = host();
  if (h) h.replaceChildren();
}

function clearState() {
  const s = stateEl();
  if (s) s.classList.add('hidden');
}

async function render(code, id, theme) {
  ensureInit(theme);
  clearState();
  const h = host();
  const renderId = id || 'm' + ++seq;
  const t0 = performance.now();
  try {
    // parse first so a malformed diagram reports cleanly instead of half-rendering
    await mermaid.parse(code);
    const { svg, bindFunctions } = await mermaid.render(renderId, code);
    h.innerHTML = svg;
    const svgEl = h.querySelector('svg');
    if (bindFunctions && svgEl) bindFunctions(h);
    post({ type: 'rendered', ok: true, ms: Math.round(performance.now() - t0), hasSvg: !!svgEl });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    showState(message);
    if (stateEl()) stateEl().classList.add('err');
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
    if (stateEl()) stateEl().classList.remove('err');
    render(String(msg.code), msg.id, msg.theme);
  } else if (msg.type === 'state') {
    if (stateEl()) stateEl().classList.remove('err');
    showState(String(msg.text || ''));
    post({ type: 'rendered', ok: true, ms: 0, state: msg.kind });
  }
});

post({ type: 'preview-ready' });
