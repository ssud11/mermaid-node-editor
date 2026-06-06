// Sidebar UI (vanilla JS, no framework) — a filterable master-detail list of the
// current Mermaid block's tags. Compact rows scale to large diagrams; click a row
// to expand its editor and reveal it in the source. DOM is built with
// createElement + textContent (never innerHTML) so user label/id text can never
// inject markup.

// eslint-disable-next-line no-undef
const vscode = acquireVsCodeApi();

const root = document.getElementById('root');
const errorBox = document.getElementById('error');

let current = null; // last BlockView
let query = ''; // search/filter text
let selectedId = null; // expanded row id
let selectedKind = null; // 'node' | 'subgraph'

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'update':
      hideError();
      current = msg.block;
      if (msg.focusedId !== undefined && msg.focusedId !== null) {
        selectId(msg.focusedId);
      } else {
        ensureSelectionValid();
      }
      render();
      scrollSelectedIntoView();
      break;
    case 'clear':
      current = null;
      selectedId = null;
      selectedKind = null;
      render();
      break;
    case 'error':
      showError(msg.message);
      // Reset the field(s) to the canonical value carried with the error WITHOUT
      // hiding the error. render() only rebuilds #root, so #error stays visible —
      // the user sees both the failure reason and the restored value.
      if (msg.block) {
        current = msg.block;
        ensureSelectionValid();
        render();
      }
      break;
  }
});

function selectId(id) {
  if (!current) return;
  if (current.nodes.some((n) => n.id === id)) {
    selectedId = id;
    selectedKind = 'node';
  } else if (current.subgraphs.some((s) => s.id === id)) {
    selectedId = id;
    selectedKind = 'subgraph';
  }
}

// Drop a selection that no longer exists (e.g. the selected node was removed).
function ensureSelectionValid() {
  if (!current) return;
  const present =
    (selectedKind === 'node' && current.nodes.some((n) => n.id === selectedId)) ||
    (selectedKind === 'subgraph' && current.subgraphs.some((s) => s.id === selectedId));
  if (!present) {
    selectedId = null;
    selectedKind = null;
  }
}

function showError(text) {
  errorBox.textContent = text;
  errorBox.hidden = false;
}

function hideError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs || {})) node.setAttribute(k, v);
  for (const child of children) node.appendChild(child);
  return node;
}

function field(labelText, input) {
  return el('div', { class: 'field' }, [el('label', { text: labelText }), input]);
}

function textInput(value, className) {
  const input = el('input', { class: className, attrs: { type: 'text', value } });
  input.value = value;
  return input;
}

function send(type, id, value) {
  vscode.postMessage({ type, id, value });
}

function warningFor(id) {
  const w = (current && current.warnings ? current.warnings : []).find((x) => x.id === id);
  return w ? w.message : null;
}

function render() {
  root.replaceChildren();

  if (!current) {
    root.appendChild(
      el('div', {
        class: 'empty',
        text: 'Place your cursor inside a Mermaid flowchart (a ```mermaid block in Markdown, or a .mmd file) to edit its nodes here.',
      })
    );
    return;
  }

  const sub = el('div', { class: 'subhead' });
  sub.appendChild(el('span', { class: 'badge', text: current.diagramType || 'diagram' }));
  if (current.fileName) {
    sub.appendChild(document.createTextNode('  ' + current.fileName));
  }
  root.appendChild(sub);

  if (!current.supported) {
    root.appendChild(
      el('div', {
        class: 'empty',
        text: 'This diagram type is not supported in v1. The Mermaid Node Editor currently edits flowcharts only (graph / flowchart).',
      })
    );
    return;
  }

  // --- Search / filter ---
  const search = textInput(query, 'search');
  search.setAttribute('type', 'search');
  search.setAttribute('placeholder', 'Filter by id or label…');
  search.setAttribute('aria-label', 'Filter nodes');
  // Filter in place (no full re-render) so the box keeps focus while typing.
  search.addEventListener('input', () => {
    query = search.value;
    applyFilter();
  });
  root.appendChild(search);

  // --- Nodes ---
  root.appendChild(el('div', { class: 'section-title', text: `Nodes (${current.nodes.length})` }));
  if (current.nodes.length === 0) {
    root.appendChild(el('div', { class: 'empty', text: 'No nodes with labels found in this diagram.' }));
  }
  const nodeList = el('div', { class: 'list' });
  for (const node of current.nodes) {
    nodeList.appendChild(renderRow(node, 'node'));
  }
  root.appendChild(nodeList);

  // --- Subgraphs ---
  if (current.subgraphs.length > 0) {
    root.appendChild(
      el('div', { class: 'section-title', text: `Subgraphs (${current.subgraphs.length})` })
    );
    const sgList = el('div', { class: 'list' });
    for (const sg of current.subgraphs) {
      sgList.appendChild(renderRow(sg, 'subgraph'));
    }
    root.appendChild(sgList);
  }

  applyFilter();
}

function renderRow(item, kind) {
  const selected = selectedId === item.id && selectedKind === kind;
  const warnMsg = warningFor(item.id);

  const head = el('div', { class: 'row-head' });
  head.appendChild(el('span', { class: 'row-id', text: item.id }));
  head.appendChild(el('span', { class: 'row-label', text: item.label || '—' }));
  if (warnMsg) {
    const w = el('span', { class: 'row-warn', text: '⚠' });
    w.setAttribute('title', warnMsg);
    head.appendChild(w);
  }
  head.addEventListener('click', () => {
    if (selectedId === item.id && selectedKind === kind) {
      selectedId = null;
      selectedKind = null;
    } else {
      selectedId = item.id;
      selectedKind = kind;
      send('nodeClicked', item.id, kind); // reveal it in the source editor
    }
    render();
    scrollSelectedIntoView();
  });

  const row = el('div', { class: 'row' + (selected ? ' selected' : '') }, [head]);
  row.setAttribute('data-search', (item.id + ' ' + (item.label || '')).toLowerCase());
  if (selected) {
    row.appendChild(kind === 'node' ? nodeDetail(item) : subgraphDetail(item));
  }
  return row;
}

function nodeDetail(node) {
  const children = [];

  const warnMsg = warningFor(node.id);
  if (warnMsg) {
    children.push(el('div', { class: 'warn-banner', text: '⚠ ' + warnMsg }));
  }

  const idInput = textInput(node.id, 'id-field');
  idInput.addEventListener('change', () => {
    const next = idInput.value.trim();
    if (next && next !== node.id) send('nodeIdChanged', node.id, next);
  });
  children.push(field('ID', idInput));

  const labelInput = textInput(node.label, '');
  labelInput.addEventListener('change', () => {
    if (labelInput.value !== node.label) send('nodeLabelChanged', node.id, labelInput.value);
  });
  children.push(field('Label', labelInput));

  if (node.outgoing.length || node.incoming.length) {
    const conn = el('div', { class: 'connections' });
    if (node.outgoing.length) {
      conn.appendChild(el('span', { class: 'arrow', text: '→ ' }));
      conn.appendChild(document.createTextNode(node.outgoing.join(', ')));
    }
    if (node.outgoing.length && node.incoming.length) {
      conn.appendChild(el('br'));
    }
    if (node.incoming.length) {
      conn.appendChild(el('span', { class: 'arrow', text: '← ' }));
      conn.appendChild(document.createTextNode(node.incoming.join(', ')));
    }
    children.push(conn);
  }

  return el('div', { class: 'row-detail' }, children);
}

function subgraphDetail(sg) {
  const children = [];

  const warnMsg = warningFor(sg.id);
  if (warnMsg) {
    children.push(el('div', { class: 'warn-banner', text: '⚠ ' + warnMsg }));
  }

  const idInput = textInput(sg.id, 'id-field');
  idInput.setAttribute('disabled', 'true'); // subgraph id is read-only in v1
  children.push(field('Subgraph ID', idInput));

  const labelInput = textInput(sg.label, '');
  labelInput.addEventListener('change', () => {
    if (labelInput.value !== sg.label) send('subgraphLabelChanged', sg.id, labelInput.value);
  });
  children.push(field('Title', labelInput));

  return el('div', { class: 'row-detail' }, children);
}

function applyFilter() {
  const q = query.trim().toLowerCase();
  for (const row of root.querySelectorAll('.row')) {
    const hay = row.getAttribute('data-search') || '';
    row.style.display = !q || hay.includes(q) ? '' : 'none';
  }
}

function scrollSelectedIntoView() {
  if (!selectedId) return;
  const row = root.querySelector('.row.selected');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

// Ask the extension for an initial render once the script is live.
vscode.postMessage({ type: 'ready' });
