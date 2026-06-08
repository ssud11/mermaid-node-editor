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

  private updateFromActiveEditor(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      this.updateFromEditor(editor);
    } else {
      this.send({ type: 'state', kind: 'empty', text: 'Open a Mermaid diagram to preview it.' });
    }
  }

  private updateFromEditor(editor: vscode.TextEditor): void {
    const doc = editor.document;
    if (!isSupportedDoc(doc)) {
      this.send({
        type: 'state',
        kind: 'empty',
        text: 'Place your cursor inside a Mermaid diagram (a ```mermaid block or a .mmd file) to preview it.',
      });
      return;
    }
    const block = getBlockAtLine(doc, editor.selection.active.line);
    if (!block) {
      this.send({
        type: 'state',
        kind: 'empty',
        text: 'No Mermaid diagram at the cursor — move into a ```mermaid block to preview it.',
      });
      return;
    }
    if (!block.supported) {
      this.send({
        type: 'state',
        kind: 'unsupported',
        text: `Preview supports flowcharts (graph / flowchart). “${block.diagramType}” isn't supported in v1.`,
      });
      return;
    }
    this.panel.title = `Preview ${doc.uri.path.split('/').pop() ?? ''}`;
    const code = buildDiagramSource(doc.getText(), isMmd(doc), block.startLine, block.endLine);
    this.send({ type: 'render', code, id: 'm' + ++this.renderSeq, theme: currentTheme() });
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
