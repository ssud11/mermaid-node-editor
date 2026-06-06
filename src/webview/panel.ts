// Sidebar webview lifecycle + message routing between the extension and the UI.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { findMermaidBlocks, MermaidBlock } from '../parser';
import {
  computeIdRename,
  computeLabelEdit,
  computeSubgraphLabelEdit,
  EditResult,
  TextEditDesc,
} from '../editor';
import { findDuplicateDeclarations } from '../analysis';

export function isMmd(doc: vscode.TextDocument): boolean {
  return (
    doc.languageId === 'mermaid' ||
    doc.fileName.endsWith('.mmd') ||
    doc.fileName.endsWith('.mermaid')
  );
}

export function isSupportedDoc(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'markdown' || isMmd(doc);
}

export function getBlocks(doc: vscode.TextDocument): MermaidBlock[] {
  return findMermaidBlocks(doc.getText(), isMmd(doc));
}

export function getBlockAtLine(doc: vscode.TextDocument, line: number): MermaidBlock | undefined {
  const blocks = getBlocks(doc);
  if (isMmd(doc)) {
    return blocks[0];
  }
  return blocks.find((b) => line >= b.startLine && line <= b.endLine);
}

// What we ship to the webview — a serialisable view of the block.
interface BlockView {
  startLine: number;
  diagramType: string;
  supported: boolean;
  fileName: string;
  nodes: Array<{ id: string; label: string; outgoing: string[]; incoming: string[] }>;
  subgraphs: Array<{ id: string; label: string; editable: boolean }>;
  edgeCount: number;
  warnings: Array<{ id: string; message: string }>; // duplicate-tag lint, keyed by id
}

export class MermaidEditorProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'mermaidNodeEditor';

  private view?: vscode.WebviewView;
  private currentUri?: vscode.Uri;
  private currentBlockStart = -1;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'webview')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.refreshFromActiveEditor();
  }

  /** Re-render from whatever the active editor's cursor is on. */
  refreshFromActiveEditor(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      this.onSelection(editor);
    } else {
      this.clear();
    }
  }

  onSelection(editor: vscode.TextEditor): void {
    const doc = editor.document;
    if (!isSupportedDoc(doc)) {
      this.clear();
      return;
    }
    const line = editor.selection.active.line;
    const block = getBlockAtLine(doc, line);
    if (!block) {
      this.clear();
      return;
    }
    this.currentUri = doc.uri;
    this.currentBlockStart = block.startLine;
    this.post({ type: 'update', block: this.toView(block, doc) });
  }

  onDocChange(doc: vscode.TextDocument): void {
    if (this.currentUri && doc.uri.toString() === this.currentUri.toString()) {
      const block = getBlockAtLine(doc, this.currentBlockStart);
      if (block) {
        this.currentBlockStart = block.startLine;
        this.post({ type: 'update', block: this.toView(block, doc) });
      }
    }
  }

  private clear(): void {
    this.currentUri = undefined;
    this.currentBlockStart = -1;
    this.post({ type: 'clear' });
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private toView(block: MermaidBlock, doc: vscode.TextDocument): BlockView {
    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();
    const push = (map: Map<string, string[]>, key: string, value: string) => {
      const list = map.get(key);
      if (list) {
        list.push(value);
      } else {
        map.set(key, [value]);
      }
    };
    for (const e of block.edges) {
      push(outgoing, e.from, e.to);
      push(incoming, e.to, e.from);
    }
    const lines = doc.getText().split(/\r?\n/);
    const warnings = findDuplicateDeclarations(block, lines).map((d) => ({ id: d.id, message: d.message }));
    return {
      startLine: block.startLine,
      diagramType: block.diagramType,
      supported: block.supported,
      fileName: doc.uri.path.split('/').pop() ?? '',
      nodes: block.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        outgoing: outgoing.get(n.id) ?? [],
        incoming: incoming.get(n.id) ?? [],
      })),
      subgraphs: block.subgraphs.map((s) => ({ id: s.id, label: s.label, editable: true })),
      edgeCount: block.edges.length,
      warnings,
    };
  }

  // Public so the integration test can drive a webview message end-to-end.
  async onMessage(msg: any): Promise<void> {
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    // The webview signals it has loaded + attached its listener — (re)send the
    // current block now; the initial post in resolveWebviewView can race ahead
    // of the webview script being ready, dropping the first render.
    if (msg.type === 'ready') {
      this.refreshFromActiveEditor();
      return;
    }
    if (!this.currentUri) {
      return;
    }

    // Values from the webview are untrusted; collapse newlines so a pasted
    // multi-line value can't split the source line.
    const value = typeof msg.value === 'string' ? msg.value.replace(/[\r\n]+/g, ' ') : '';

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(this.currentUri);
    } catch {
      this.post({ type: 'error', message: 'Source document is no longer open.' });
      return;
    }

    // Re-parse fresh so positions reflect the live document.
    const block = getBlockAtLine(doc, this.currentBlockStart);
    if (!block) {
      this.post({ type: 'error', message: 'Could not locate the Mermaid block to edit.' });
      return;
    }
    const lines = doc.getText().split(/\r?\n/);

    let result: EditResult | undefined;
    switch (msg.type) {
      case 'nodeLabelChanged':
        result = computeLabelEdit(block, msg.id, value);
        break;
      case 'nodeIdChanged':
        result = computeIdRename(block, lines, msg.id, value);
        break;
      case 'subgraphLabelChanged':
        result = computeSubgraphLabelEdit(block, lines, msg.id, value);
        break;
      default:
        return;
    }

    if (!result.ok) {
      // Single message: show the error AND carry the canonical block so the field
      // resets. Sending a separate follow-up 'update' would hide the error the
      // instant it was shown (the webview's 'update' handler clears the error box).
      this.post({ type: 'error', message: result.error ?? 'Edit failed.', block: this.toView(block, doc) });
      return;
    }

    if (result.edits.length > 0) {
      await this.applyEdits(doc.uri, result.edits);
    }

    const fresh = await vscode.workspace.openTextDocument(this.currentUri);
    const refreshed = getBlockAtLine(fresh, this.currentBlockStart);
    if (refreshed) {
      this.currentBlockStart = refreshed.startLine;
      this.post({ type: 'update', block: this.toView(refreshed, fresh) });
    }
  }

  private async applyEdits(uri: vscode.Uri, edits: TextEditDesc[]): Promise<void> {
    const we = new vscode.WorkspaceEdit();
    for (const e of edits) {
      we.replace(uri, new vscode.Range(e.line, e.startChar, e.line, e.endChar), e.newText);
    }
    await vscode.workspace.applyEdit(we);
  }

  private getHtml(webview: vscode.Webview): string {
    const root = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.js'));
    const nonce = makeNonce();
    const htmlPath = vscode.Uri.joinPath(root, 'index.html').fsPath;
    const template = fs.readFileSync(htmlPath, 'utf8');
    return template
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{styleUri}}/g, styleUri.toString())
      .replace(/{{scriptUri}}/g, scriptUri.toString());
  }
}

function makeNonce(): string {
  // CSPRNG — a CSP nonce's entire value is being unguessable per load.
  return crypto.randomBytes(16).toString('hex');
}
