// Extension entry point. Registers the sidebar webview provider, the commands,
// and the listeners that keep the panel in sync with the active editor.

import * as vscode from 'vscode';
import { MermaidEditorProvider } from './webview/panel';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MermaidEditorProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MermaidEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mermaid-node-editor.open', async () => {
      await vscode.commands.executeCommand('mermaidNodeEditor.focus');
      provider.refreshFromActiveEditor();
    }),
    vscode.commands.registerCommand('mermaid-node-editor.refresh', () => {
      provider.refreshFromActiveEditor();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => provider.onSelection(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        provider.onSelection(editor);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => provider.onDocChange(e.document))
  );
}

export function deactivate(): void {
  // nothing to clean up
}
