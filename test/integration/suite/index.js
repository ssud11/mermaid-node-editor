// IT-1 smoke — runs INSIDE the VS Code extension host (so `require('vscode')` works).
// Goal: prove the extension actually loads/activates and its webview view resolves
// in a real host — the "never run as an extension" gap. No mocha; throw = fail.
const path = require('path');
const assert = require('assert');
const vscode = require('vscode');

async function run() {
  // 1. Extension is present and activates
  const ext = vscode.extensions.getExtension('ssud11.mermaid-node-editor');
  assert.ok(ext, 'extension ssud11.mermaid-node-editor should be discoverable');
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
}

module.exports = { run };
