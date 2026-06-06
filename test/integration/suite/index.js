// IT-1 smoke — runs INSIDE the VS Code extension host (so `require('vscode')` works).
// Goal: prove the extension actually loads/activates and its webview view resolves
// in a real host — the "never run as an extension" gap. No mocha; throw = fail.
const path = require('path');
const assert = require('assert');
const vscode = require('vscode');

async function run() {
  // 1. Extension is present and activates
  const ext = vscode.extensions.getExtension('SS-inkwright.mermaid-node-editor');
  assert.ok(ext, 'extension SS-inkwright.mermaid-node-editor should be discoverable');
  const api = await ext.activate();
  assert.ok(ext.isActive, 'extension should activate without throwing');
  assert.ok(api && api.provider, 'activate() should expose the provider for testing');

  // 2. Contributed commands are registered
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['mermaid-node-editor.open', 'mermaid-node-editor.refresh']) {
    assert.ok(cmds.includes(c), `command "${c}" should be registered`);
  }

  // 3. Open the demo flowchart
  const demo = path.resolve(__dirname, '../../../examples/demo.mmd');
  const doc = await vscode.workspace.openTextDocument(demo);
  await vscode.window.showTextDocument(doc);
  assert.ok(doc.getText().includes('graph') || doc.getText().includes('flowchart'),
    'demo.mmd should be a flowchart');

  // 4. Reveal the sidebar view -> triggers panel.ts resolveWebviewView()
  //    (loads index.html via asWebviewUri, wires the message listener) — the
  //    zero-coverage path. A throw here surfaces a real runtime defect.
  await vscode.commands.executeCommand('mermaidNodeEditor.focus');
  await new Promise((r) => setTimeout(r, 1500));
  console.log('IT-1 smoke PASS: activate + commands + demo open + webview resolve');

  // 5. IT-2 — write-back glue end-to-end: onMessage -> WorkspaceEdit -> live doc.
  const provider = api.provider;
  const src = 'graph TD\n  A[Start] --> B[Stop]\n  B --> A\n';
  const wbDoc = await vscode.workspace.openTextDocument({ language: 'mermaid', content: src });
  const wbEditor = await vscode.window.showTextDocument(wbDoc);
  wbEditor.selection = new vscode.Selection(1, 2, 1, 2); // cursor inside the graph
  provider.onSelection(wbEditor);

  // ID rename A -> Z must propagate to the edge reference "B --> A"
  await provider.onMessage({ type: 'nodeIdChanged', id: 'A', value: 'Z' });
  let text = (await vscode.workspace.openTextDocument(wbDoc.uri)).getText();
  assert.ok(text.includes('Z[Start]'), 'node A should be renamed to Z[Start]');
  assert.ok(/B --> Z/.test(text), 'edge "B --> A" should propagate to "B --> Z"');
  assert.ok(!text.includes('A[Start]'), 'old id A[Start] should be gone');

  // Label edit on B
  await provider.onMessage({ type: 'nodeLabelChanged', id: 'B', value: 'Halt' });
  text = (await vscode.workspace.openTextDocument(wbDoc.uri)).getText();
  assert.ok(text.includes('B[Halt]'), 'node B label should become Halt');

  console.log('IT-2 write-back PASS: id-rename propagates to edges + label edit lands via WorkspaceEdit');

  // 6. Multi-file / multi-block / subgraph coverage — scenarios previously only
  //    inferred from reading the code, now asserted end-to-end.
  const readText = async (uri) => (await vscode.workspace.openTextDocument(uri)).getText();

  // (a) Active-editor targeting: an edit lands in the FOCUSED file only. This is
  //     also the split-editor mechanism (the provider only ever sees onSelection).
  const docA = await vscode.workspace.openTextDocument({
    language: 'mermaid',
    content: 'graph TD\n  A[Alpha] --> B[Bee]\n',
  });
  const docB = await vscode.workspace.openTextDocument({
    language: 'mermaid',
    content: 'graph TD\n  A[Gamma] --> B[Dee]\n',
  });
  const edA = await vscode.window.showTextDocument(docA, { preview: false });
  edA.selection = new vscode.Selection(1, 2, 1, 2);
  provider.onSelection(edA);
  await provider.onMessage({ type: 'nodeLabelChanged', id: 'A', value: 'Alpha2' });

  const edB = await vscode.window.showTextDocument(docB, { preview: false });
  edB.selection = new vscode.Selection(1, 2, 1, 2);
  provider.onSelection(edB);
  await provider.onMessage({ type: 'nodeLabelChanged', id: 'A', value: 'Gamma2' });

  const tA = await readText(docA.uri);
  const tB = await readText(docB.uri);
  assert.ok(tA.includes('A[Alpha2]') && !tA.includes('Gamma2'), 'edit must land in focused file A only');
  assert.ok(tB.includes('A[Gamma2]') && !tB.includes('Alpha2'), 'edit must land in focused file B only');
  console.log('IT-6 PASS: active-editor switching targets the focused file (covers split focus)');

  // (b) Multi-block Markdown: the cursor scopes which block is edited; a node that
  //     lives in another block can't be touched.
  const md = [
    '# Demo', '',
    '```mermaid', 'graph TD', '  A[First] --> B[Two]', '```', '',
    'Prose between blocks.', '',
    '```mermaid', 'graph TD', '  C[Third] --> D[Four]', '```', '',
  ].join('\n');
  const mdDoc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
  const mdEd = await vscode.window.showTextDocument(mdDoc, { preview: false });

  mdEd.selection = new vscode.Selection(4, 4, 4, 4); // inside block 1 (node A)
  provider.onSelection(mdEd);
  await provider.onMessage({ type: 'nodeLabelChanged', id: 'A', value: 'First2' });
  await provider.onMessage({ type: 'nodeLabelChanged', id: 'C', value: 'NOPE' }); // C is in block 2 -> no-op

  mdEd.selection = new vscode.Selection(11, 4, 11, 4); // inside block 2 (node C)
  provider.onSelection(mdEd);
  await provider.onMessage({ type: 'nodeLabelChanged', id: 'C', value: 'Third2' });

  const mdText = await readText(mdDoc.uri);
  assert.ok(mdText.includes('A[First2]'), 'block 1 node editable when cursor is in block 1');
  assert.ok(mdText.includes('C[Third2]'), 'block 2 node editable when cursor is in block 2');
  assert.ok(!mdText.includes('NOPE'), 'a node outside the cursor block must not be edited');
  console.log('IT-6 PASS: multi-block Markdown is cursor-scoped to the right block');

  // (c) Cursor outside any block -> empty state -> edit messages are no-ops.
  mdEd.selection = new vscode.Selection(7, 0, 7, 0); // prose line, between blocks
  provider.onSelection(mdEd);
  const before = await readText(mdDoc.uri);
  await provider.onMessage({ type: 'nodeLabelChanged', id: 'A', value: 'SHOULD_NOT_APPLY' });
  const after = await readText(mdDoc.uri);
  assert.strictEqual(after, before, 'with cursor outside any block, an edit message must be a no-op');
  console.log('IT-6 PASS: cursor outside a block clears + ignores edits');

  // (d) Subgraph title edit end-to-end (through the panel glue, not just the pure fn).
  const sgDoc = await vscode.workspace.openTextDocument({
    language: 'mermaid',
    content: 'graph TD\n  subgraph sg [Cluster]\n    A[X] --> B[Y]\n  end\n',
  });
  const sgEd = await vscode.window.showTextDocument(sgDoc, { preview: false });
  sgEd.selection = new vscode.Selection(2, 4, 2, 4);
  provider.onSelection(sgEd);
  await provider.onMessage({ type: 'subgraphLabelChanged', id: 'sg', value: 'Renamed' });
  const sgText = await readText(sgDoc.uri);
  assert.ok(/subgraph sg \[Renamed\]/.test(sgText), 'subgraph title should write back via the panel glue');
  console.log('IT-6 PASS: subgraph title edit lands end-to-end');

  // (e) A newline in a pasted label is collapsed, not injected into the source.
  const nlDoc = await vscode.workspace.openTextDocument({
    language: 'mermaid',
    content: 'graph TD\n  A[One] --> B[Two]\n',
  });
  const nlEd = await vscode.window.showTextDocument(nlDoc, { preview: false });
  nlEd.selection = new vscode.Selection(1, 4, 1, 4);
  provider.onSelection(nlEd);
  await provider.onMessage({ type: 'nodeLabelChanged', id: 'A', value: 'Line1\nLine2' });
  const nlText = await readText(nlDoc.uri);
  assert.ok(nlText.includes('A[Line1 Line2]'), 'newline in a label should collapse to a space');
  assert.ok(!nlText.includes('Line1\nLine2'), 'a label newline must not split the source line');
  console.log('IT-6 PASS: newline in a pasted label is collapsed, not injected');

  // (f) The 'ready' handshake is handled (previously a silent no-op).
  await provider.onMessage({ type: 'ready' });
  console.log('IT-6 PASS: ready handshake handled without error');

  // 7. A2 — duplicate-tag linting surfaces as native Diagnostics (warnings).
  const dupDoc = await vscode.workspace.openTextDocument({
    language: 'mermaid',
    content: 'graph TD\n  A[First] --> B[x]\n  A[Second]\n  subgraph S1 [One]\n  end\n  subgraph S1 [Two]\n  end\n',
  });
  await vscode.window.showTextDocument(dupDoc, { preview: false });
  // Diagnostics compute on open; poll briefly for the collection to populate.
  let diags = [];
  for (let i = 0; i < 30; i++) {
    diags = vscode.languages.getDiagnostics(dupDoc.uri);
    if (diags.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(diags.some((d) => /defined more than once/i.test(d.message)), 'duplicate node id should warn');
  assert.ok(diags.some((d) => /declared more than once/i.test(d.message)), 'duplicate subgraph id should warn');
  assert.ok(
    diags.every((d) => d.severity === vscode.DiagnosticSeverity.Warning),
    'duplicate-tag lints should be warnings'
  );
  console.log('A2 PASS: duplicate-tag diagnostics surface as warnings');

  // 8. A3 — Go to Definition + Find References on a tag.
  const navDoc = await vscode.workspace.openTextDocument({
    language: 'mermaid',
    content: 'graph LR\nA[Start] --> B[Mid]\nB --> C[End]\nC --> A\n',
  });
  await vscode.window.showTextDocument(navDoc, { preview: false });

  const defs = await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider',
    navDoc.uri,
    new vscode.Position(3, 6) // the "A" in "C --> A"
  );
  assert.ok(Array.isArray(defs) && defs.length >= 1, 'go-to-definition should resolve A');
  const defRange = defs[0].range || defs[0].targetRange;
  assert.strictEqual(defRange.start.line, 1, 'A should be defined on line 1 (A[Start])');

  const refs = await vscode.commands.executeCommand(
    'vscode.executeReferenceProvider',
    navDoc.uri,
    new vscode.Position(1, 0) // on the A definition
  );
  const refLines = refs.map((r) => r.range.start.line).sort((a, b) => a - b);
  assert.ok(
    refLines.includes(1) && refLines.includes(3),
    'references should include the def (line 1) and the C --> A edge (line 3)'
  );
  console.log('A3 PASS: go-to-definition + find-references resolve tags across edges');
}

module.exports = { run };
