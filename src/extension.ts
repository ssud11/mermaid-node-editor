// Extension entry point. Registers the sidebar webview provider, the commands,
// and the listeners that keep the panel in sync with the active editor.

import * as vscode from 'vscode';
import { MermaidEditorProvider, isSupportedDoc, isMmd } from './webview/panel';
import { MermaidPreviewPanel } from './webview/previewPanel';
import { findMermaidBlocks } from './parser';
import { findDuplicateDeclarations } from './analysis';
import { MermaidDefinitionProvider, MermaidReferenceProvider, MermaidRenameProvider } from './providers';

// Providers fire for .mmd and inside ```mermaid fences in markdown (gated by
// getBlockAtLine returning a block only when the cursor is within one).
const MERMAID_SELECTOR: vscode.DocumentSelector = [{ language: 'mermaid' }, { language: 'markdown' }];

// Returned from activate() as the extension's public API — the integration test
// uses ext.exports.provider to drive the provider end-to-end.
export interface MermaidEditorApi {
  provider: MermaidEditorProvider;
}

/**
 * Duplicate-tag warnings for a document: one tag bound to two different elements
 * (two subgraphs, a node and a subgraph, or the same id with different labels).
 * Only fires inside Mermaid blocks — `findMermaidBlocks` already scopes to them.
 */
export function computeMermaidDiagnostics(doc: vscode.TextDocument): vscode.Diagnostic[] {
  if (!isSupportedDoc(doc)) {
    return [];
  }
  const text = doc.getText();
  const lines = text.split(/\r?\n/);
  const out: vscode.Diagnostic[] = [];
  for (const block of findMermaidBlocks(text, isMmd(doc))) {
    if (!block.supported) {
      continue;
    }
    for (const dup of findDuplicateDeclarations(block, lines)) {
      for (const loc of dup.locations) {
        const range = new vscode.Range(loc.line, loc.startChar, loc.line, loc.endChar);
        const d = new vscode.Diagnostic(range, dup.message, vscode.DiagnosticSeverity.Warning);
        d.source = 'Mermaid Node Editor';
        d.code = dup.reason;
        out.push(d);
      }
    }
  }
  return out;
}

export function activate(context: vscode.ExtensionContext): MermaidEditorApi {
  const provider = new MermaidEditorProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MermaidEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mermaid-node-editor.open', async () => {
      await vscode.commands.executeCommand('mermaidNodeEditorPanel.focus');
      provider.refreshFromActiveEditor();
    }),
    vscode.commands.registerCommand('mermaid-node-editor.refresh', () => {
      provider.refreshFromActiveEditor();
    }),
    vscode.commands.registerCommand('mermaid-node-editor.preview', () => {
      MermaidPreviewPanel.createOrShow(context.extensionUri);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      // Only react to the focused editor — not background / peek / split editors.
      if (e.textEditor === vscode.window.activeTextEditor) {
        provider.onSelection(e.textEditor);
        MermaidPreviewPanel.notifySelection(e.textEditor);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        provider.onSelection(editor);
      }
      MermaidPreviewPanel.notifyActiveEditor(editor);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => provider.onDocChange(e.document))
  );

  // Live preview re-render on edit — debounced so a mermaid render doesn't run
  // on every keystroke (it's heavier than the sidebar's data refresh above).
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const clearPreviewTimer = () => {
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = undefined;
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const doc = e.document;
      clearPreviewTimer();
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        if (!doc.isClosed) {
          MermaidPreviewPanel.notifyDocChange(doc);
        }
      }, 200);
    }),
    { dispose: clearPreviewTimer }
  );

  // Tag navigation: Go to Definition (F12 / right-click) + Find References (Shift+F12)
  // + native F2 Rename (reuses the edge-propagating computeIdRename engine).
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(MERMAID_SELECTOR, new MermaidDefinitionProvider()),
    vscode.languages.registerReferenceProvider(MERMAID_SELECTOR, new MermaidReferenceProvider()),
    vscode.languages.registerRenameProvider(MERMAID_SELECTOR, new MermaidRenameProvider())
  );

  // Duplicate-tag linting: native Diagnostics (squiggle + Problems panel).
  const diagnostics = vscode.languages.createDiagnosticCollection('mermaid-node-editor');
  const refreshDiagnostics = (doc: vscode.TextDocument) =>
    diagnostics.set(doc.uri, computeMermaidDiagnostics(doc));
  let diagTimer: ReturnType<typeof setTimeout> | undefined;
  const clearDiagTimer = () => {
    if (diagTimer) {
      clearTimeout(diagTimer);
      diagTimer = undefined;
    }
  };
  context.subscriptions.push(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Debounce: re-lint shortly after the user stops typing.
      const doc = e.document;
      clearDiagTimer();
      diagTimer = setTimeout(() => {
        diagTimer = undefined;
        // Skip if the doc was closed during the debounce window — otherwise we'd
        // re-add phantom squiggles to a document that's already gone.
        if (!doc.isClosed) {
          refreshDiagnostics(doc);
        }
      }, 250);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
    { dispose: clearDiagTimer } // drop any pending timer on extension shutdown
  );
  // Lint anything already open at activation.
  for (const doc of vscode.workspace.textDocuments) {
    refreshDiagnostics(doc);
  }

  return { provider };
}

export function deactivate(): void {
  // nothing to clean up
}
