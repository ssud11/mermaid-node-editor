// Sidebar UI (vanilla JS, no framework). Renders the current Mermaid block's
// nodes/subgraphs as editable rows and posts changes back to the extension.
// DOM is built with createElement + textContent (never innerHTML) so user
// label/id text can never inject markup.

// eslint-disable-next-line no-undef
const vscode = acquireVsCodeApi();

const root = document.getElementById('root');
const errorBox = document.getElementById('error');

let current = null; // last BlockView

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'update':
      hideError();
      current = msg.block;
      render();
      break;
    case 'clear':
      current = null;
      render();
      break;
    case 'error':
      showError(msg.message);
      break;
  }
});

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

  root.appendChild(el('div', { class: 'header', text: 'Mermaid Node Editor' }));
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

  // --- Nodes ---
  root.appendChild(el('div', { class: 'section-title', text: `Nodes (${current.nodes.length})` }));
  if (current.nodes.length === 0) {
    root.appendChild(
      el('div', { class: 'empty', text: 'No nodes with labels found in this diagram.' })
    );
  }
  for (const node of current.nodes) {
    root.appendChild(renderNode(node));
  }

  // --- Subgraphs ---
  if (current.subgraphs.length > 0) {
    root.appendChild(
      el('div', { class: 'section-title', text: `Subgraphs (${current.subgraphs.length})` })
    );
    for (const sg of current.subgraphs) {
      root.appendChild(renderSubgraph(sg));
    }
  }
}

function renderNode(node) {
  const idInput = textInput(node.id, 'id-field');
  idInput.addEventListener('change', () => {
    const next = idInput.value.trim();
    if (next && next !== node.id) send('nodeIdChanged', node.id, next);
  });

  const labelInput = textInput(node.label, '');
  labelInput.addEventListener('change', () => {
    if (labelInput.value !== node.label) send('nodeLabelChanged', node.id, labelInput.value);
  });

  const children = [field('ID', idInput), field('Label', labelInput)];

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

  return el('div', { class: 'node' }, children);
}

function renderSubgraph(sg) {
  const idInput = textInput(sg.id, 'id-field');
  idInput.setAttribute('disabled', 'true');

  const labelInput = textInput(sg.label, '');
  labelInput.addEventListener('change', () => {
    if (labelInput.value !== sg.label) send('subgraphLabelChanged', sg.id, labelInput.value);
  });

  return el('div', { class: 'node' }, [field('Subgraph ID', idInput), field('Title', labelInput)]);
}

// Ask the extension for an initial render once the script is live.
vscode.postMessage({ type: 'ready' });
