// Live-preview WebviewPanel (Phase B / v1.2). Opens in an editor column beside
// the source and renders the Mermaid block at the cursor using the bundled
// mermaid + ELK renderer (dist/webview/preview.js). One panel, reused/revealed.
//
// B1 scope: open the surface, render the block at the cursor, follow the
// cursor/active editor, and show graceful empty / unsupported / error states.
// (Live re-render on edit + theme-match + pan/zoom land in B2.)

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { MermaidBlock } from '../parser';
import { isMmd, isSupportedDoc, getBlockAtLine } from './panel';
import { buildDiagramSource } from '../preview-source';

type RenderMsg =
  | { type: 'render'; code: string; id: string; theme: 'dark' | 'light' }
  | { type: 'state'; kind: 'empty' | 'unsupported'; text: string };

export class MermaidPreviewPanel {
  public static readonly viewType = 'mermaidNodeEditorPreview';
  private static current?: MermaidPreviewPanel;

  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private queued?: RenderMsg; // latest intent posted before the webview booted
  private renderSeq = 0;
  // The block currently being previewed — so a live edit re-renders the right
  // one even when the cursor has wandered into surrounding prose.
  private sourceUri?: vscode.Uri;
  private sourceBlockStart = -1;

  /** Open the preview beside the active editor, or reveal the existing one. */
  static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
    if (MermaidPreviewPanel.current) {
      MermaidPreviewPanel.current.panel.reveal(column, true);
      MermaidPreviewPanel.current.updateFromActiveEditor();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      MermaidPreviewPanel.viewType,
      'Mermaid Preview',
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
          vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'preview'),
        ],
      }
    );
    MermaidPreviewPanel.current = new MermaidPreviewPanel(panel, extensionUri);
  }

  /** Source → preview sync, driven by the extension's editor listeners. */
  static notifySelection(editor: vscode.TextEditor): void {
    MermaidPreviewPanel.current?.updateFromEditor(editor);
  }
  static notifyActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (editor) {
      MermaidPreviewPanel.current?.updateFromEditor(editor);
    }
  }
  /** Live edit → re-render the tracked block (debounced by the caller). */
  static notifyDocChange(doc: vscode.TextDocument): void {
    MermaidPreviewPanel.current?.onDocChange(doc);
  }
  /** VS Code theme changed → re-render so the diagram picks up the new colors. */
  static notifyThemeChange(): void {
    MermaidPreviewPanel.current?.rerenderTracked();
  }

  private constructor(private readonly panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel.webview.html = this.getHtml(this.panel.webview, extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        // The webview signals it has booted (bundle parsed + ELK registered);
        // flush whatever we wanted to show. The first post can otherwise race
        // ahead of the script being ready and get dropped.
        if (msg && msg.type === 'preview-ready') {
          this.ready = true;
          if (this.queued) {
            this.panel.webview.postMessage(this.queued);
            this.queued = undefined;
          }
        }
      },
      null,
      this.disposables
    );
    this.updateFromActiveEditor();
  }

  /** First render on open: show the diagram at the cursor, else a hint. */
  private updateFromActiveEditor(): void {
    const editor = vscode.window.activeTextEditor;
    const block =
      editor && isSupportedDoc(editor.document)
        ? getBlockAtLine(editor.document, editor.selection.active.line)
        : undefined;
    if (editor && block) {
      if (block.supported) {
        this.renderBlock(editor.document, block);
      } else {
        this.showUnsupported(block);
      }
    } else {
      this.send({
        type: 'state',
        kind: 'empty',
        text: 'Place your cursor inside a Mermaid diagram (a ```mermaid block or a .mmd file) to preview it.',
      });
    }
  }

  /**
   * Cursor / active-editor moved. Switch the preview when the cursor enters a
   * (supported or unsupported) Mermaid block; otherwise keep the current diagram
   * up — so editing the prose around a diagram doesn't blank the preview.
   */
  private updateFromEditor(editor: vscode.TextEditor): void {
    const doc = editor.document;
    if (!isSupportedDoc(doc)) {
      return;
    }
    const block = getBlockAtLine(doc, editor.selection.active.line);
    if (!block) {
      return; // cursor is outside any block — keep showing the current diagram
    }
    if (block.supported) {
      this.renderBlock(doc, block);
    } else {
      this.showUnsupported(block);
    }
  }

  /** A document changed; re-render if it's the one we're previewing. */
  private onDocChange(doc: vscode.TextDocument): void {
    if (!this.sourceUri || doc.uri.toString() !== this.sourceUri.toString()) {
      return;
    }
    const block = getBlockAtLine(doc, this.sourceBlockStart);
    if (!block) {
      return; // the block was (temporarily) deleted mid-edit — keep the last good render
    }
    if (block.supported) {
      this.renderBlock(doc, block);
    } else {
      this.showUnsupported(block);
    }
  }

  /** Re-render the block we're currently previewing (e.g. after a theme change). */
  private rerenderTracked(): void {
    if (!this.sourceUri) {
      return;
    }
    const uriStr = this.sourceUri.toString();
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr);
    if (!doc) {
      return;
    }
    const block = getBlockAtLine(doc, this.sourceBlockStart);
    if (block && block.supported) {
      this.renderBlock(doc, block);
    }
  }

  private renderBlock(doc: vscode.TextDocument, block: MermaidBlock): void {
    this.sourceUri = doc.uri;
    this.sourceBlockStart = block.startLine;
    this.panel.title = `Preview ${doc.uri.path.split('/').pop() ?? ''}`;
    const code = buildDiagramSource(doc.getText(), isMmd(doc), block.startLine, block.endLine);
    this.send({ type: 'render', code, id: 'm' + ++this.renderSeq, theme: currentTheme() });
  }

  private showUnsupported(block: MermaidBlock): void {
    this.send({
      type: 'state',
      kind: 'unsupported',
      text: `Preview supports flowcharts (graph / flowchart). “${block.diagramType}” isn't supported in v1.`,
    });
  }

  private send(msg: RenderMsg): void {
    if (this.ready) {
      this.panel.webview.postMessage(msg);
    } else {
      this.queued = msg; // keep only the most recent pre-ready intent
    }
  }

  private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const previewDir = vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'preview');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'preview.js')
    );
    const nonce = crypto.randomBytes(16).toString('hex');
    const template = fs.readFileSync(vscode.Uri.joinPath(previewDir, 'index.html').fsPath, 'utf8');
    return template
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{scriptUri}}/g, scriptUri.toString());
  }

  private dispose(): void {
    MermaidPreviewPanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function currentTheme(): 'dark' | 'light' {
  const k = vscode.window.activeColorTheme.kind;
  return k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark';
}
