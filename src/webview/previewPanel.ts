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
import { isMmd, isSupportedDoc, getBlockAtLine, getBlocks } from './panel';
import { findTagAtPosition, findDeclaration } from '../analysis';
import { buildDiagramSource } from '../preview-source';

type RenderMsg =
  | { type: 'render'; code: string; id: string; key: string }
  | { type: 'state'; kind: 'empty' | 'unsupported'; text: string };

const HIGHLIGHT_SETTING = 'mermaid-node-editor.preview.highlightOnSelect';

export class MermaidPreviewPanel {
  public static readonly viewType = 'mermaidNodeEditorPreview';
  private static current?: MermaidPreviewPanel;

  /** Wired in activate(): lets a preview click-reveal also sync the node-editor
   *  sidebar without importing the provider here (avoids a panel↔preview cycle). */
  static onDidReveal?: (editor: vscode.TextEditor) => void;

  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private queued?: RenderMsg; // latest intent posted before the webview booted
  private renderSeq = 0;
  // The block currently being previewed — so a live edit re-renders the right
  // one even when the cursor has wandered into surrounding prose.
  private sourceUri?: vscode.Uri;
  private sourceBlockStart = -1;
  // B3: the tag highlighted in the preview (follows the source cursor). Kept here
  // so it can be re-sent when the webview boots; the webview re-applies it after
  // every render (the SVG is replaced wholesale).
  private focusedTag?: string;
  // >0 while revealTag drives the editor — editor-sync events it causes
  // (active-editor change at cursor (0,0)) must not clear the highlight. A
  // COUNTER, not a boolean: rapid double-clicks overlap two async reveals, and
  // the first one finishing must not unguard the second mid-flight.
  private revealing = 0;

  private static webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'preview'),
      ],
    };
  }

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
      { retainContextWhenHidden: true, ...MermaidPreviewPanel.webviewOptions(extensionUri) }
    );
    MermaidPreviewPanel.current = new MermaidPreviewPanel(panel, extensionUri);
  }

  /** Restore the preview on window reload (without this, a reloaded panel shows a
   *  stale cached webview instead of re-rendering). */
  static register(extensionUri: vscode.Uri): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(MermaidPreviewPanel.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        panel.webview.options = MermaidPreviewPanel.webviewOptions(extensionUri);
        MermaidPreviewPanel.current = new MermaidPreviewPanel(panel, extensionUri);
      },
    });
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
  /** A document was closed → clear the preview if it's the one we were showing. */
  static notifyDocClose(doc: vscode.TextDocument): void {
    MermaidPreviewPanel.current?.onDocClose(doc);
  }
  /** The sidebar renamed/relabeled the focused tag → re-point the highlight at the
   *  (possibly new) id; the debounced re-render then re-applies it in the webview. */
  static notifyFocusedTag(id: string | undefined): void {
    MermaidPreviewPanel.current?.setFocusedTag(id);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel.webview.html = this.getHtml(this.panel.webview, extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (!msg || typeof msg.type !== 'string') {
          return;
        }
        // The webview signals it has booted (bundle parsed + ELK registered);
        // flush whatever we wanted to show. The first post can otherwise race
        // ahead of the script being ready and get dropped.
        if (msg.type === 'preview-ready') {
          this.ready = true;
          if (this.queued) {
            this.panel.webview.postMessage(this.queued);
            this.queued = undefined;
          }
          // Config + focus ride separately from the render queue (which keeps
          // only ONE message — a queued focus must never clobber a queued render).
          this.postConfig();
          this.postFocus();
        } else if (msg.type === 'nodeClicked' && typeof msg.id === 'string') {
          void this.revealTag(msg.id);
        } else if (msg.type === 'setHighlight') {
          // Toolbar toggle → persist as the real setting; the config-change
          // listener below echoes it back so the setting stays the source of truth.
          // Write to the scope that currently holds an effective value — writing
          // Global under a workspace override would be silently shadowed and the
          // echo would flip the button straight back.
          const cfg = vscode.workspace.getConfiguration();
          const info = cfg.inspect<boolean>(HIGHLIGHT_SETTING);
          const target =
            info?.workspaceFolderValue !== undefined
              ? vscode.ConfigurationTarget.WorkspaceFolder
              : info?.workspaceValue !== undefined
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
          void cfg.update(HIGHLIGHT_SETTING, !!msg.value, target);
        }
      },
      null,
      this.disposables
    );
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration(HIGHLIGHT_SETTING)) {
          this.postConfig();
        }
      },
      null,
      this.disposables
    );
    this.updateFromActiveEditor();
  }

  private highlightEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(HIGHLIGHT_SETTING, true);
  }

  private postConfig(): void {
    if (this.ready) {
      this.panel.webview.postMessage({ type: 'config', highlightOnSelect: this.highlightEnabled() });
    }
  }

  private postFocus(): void {
    if (this.ready) {
      this.panel.webview.postMessage({ type: 'focus', id: this.focusedTag ?? null });
    }
  }

  private setFocusedTag(id: string | undefined): void {
    if (id === this.focusedTag) {
      return;
    }
    this.focusedTag = id;
    this.postFocus();
  }

  /** B3: the tag under the source cursor (a declared node or subgraph id), for the
   *  preview highlight. Mirrors the sidebar's focusedId logic in panel.onSelection. */
  private syncFocusFromCursor(editor: vscode.TextEditor, doc: vscode.TextDocument, block: MermaidBlock): void {
    const pos = editor.selection.active;
    const lines = doc.getText().split(/\r?\n/);
    const tag = findTagAtPosition(block, lines, pos.line, pos.character);
    const focused =
      tag && (block.nodes.some((n) => n.id === tag.id) || block.subgraphs.some((s) => s.id === tag.id))
        ? tag.id
        : undefined;
    this.setFocusedTag(focused);
  }

  /** First render on open: show the diagram at the cursor, else a hint. */
  private updateFromActiveEditor(): void {
    const editor = vscode.window.activeTextEditor;
    const block =
      editor && isSupportedDoc(editor.document)
        ? getBlockAtLine(editor.document, editor.selection.active.line)
        : undefined;
    if (editor && block) {
      this.showBlock(editor.document, block);
      this.syncFocusFromCursor(editor, editor.document, block);
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
    if (this.revealing > 0) {
      return; // our own revealTag(s) triggered this event — don't fight the highlight
    }
    const doc = editor.document;
    if (!isSupportedDoc(doc)) {
      return;
    }
    const block = getBlockAtLine(doc, editor.selection.active.line);
    if (!block) {
      this.setFocusedTag(undefined); // no tag under a cursor outside any block
      return; // …but keep showing the current diagram
    }
    this.showBlock(doc, block);
    this.syncFocusFromCursor(editor, doc, block);
  }

  /**
   * B3: a node was clicked in the preview → reveal + select its declaration in the
   * source (mirrors the sidebar's reveal), then let the extension sync the
   * node-editor panel via onDidReveal. Click-reveal stays active even with the
   * highlight toggled off — an explicit click is navigation, not passive noise.
   */
  private async revealTag(id: string): Promise<void> {
    if (!this.sourceUri) {
      return;
    }
    // Suppress the editor-sync listeners while revealing: showTextDocument fires
    // onDidChangeActiveTextEditor with the cursor still at (0,0) — the directive
    // line — which would clear the focus highlight for a frame before the real
    // selection lands below.
    this.revealing++;
    try {
      const uriStr = this.sourceUri.toString();
      let editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriStr);
      let doc: vscode.TextDocument;
      if (editor) {
        doc = editor.document;
      } else {
        try {
          doc = await vscode.workspace.openTextDocument(this.sourceUri);
        } catch {
          return;
        }
        editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });
      }
      const block = this.findTrackedBlock(doc);
      if (!block || !block.supported) {
        return;
      }
      const decl = findDeclaration(block, id);
      if (!decl) {
        return; // clicked element didn't map to a declared tag (e.g. a bare edge ref mermaid rendered anyway)
      }
      const start = new vscode.Position(decl.line, decl.startChar);
      const end = new vscode.Position(decl.line, decl.endChar);
      editor.selection = new vscode.Selection(start, start);
      editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      // preserveFocus keeps keyboard focus on the preview, so the selection-change
      // guard (e.textEditor === activeTextEditor) blocks the normal sync path —
      // sync the highlight and the sidebar explicitly instead.
      this.setFocusedTag(id);
      MermaidPreviewPanel.onDidReveal?.(editor);
    } finally {
      this.revealing--;
    }
  }

  /** The previewed source file was closed → reset tracking and show the hint. */
  private onDocClose(doc: vscode.TextDocument): void {
    if (this.sourceUri && doc.uri.toString() === this.sourceUri.toString()) {
      this.sourceUri = undefined;
      this.sourceBlockStart = -1;
      this.send({
        type: 'state',
        kind: 'empty',
        text: 'The source file was closed. Open a Mermaid diagram to preview it.',
      });
    }
  }

  /** A document changed; re-render if it's the one we're previewing. */
  private onDocChange(doc: vscode.TextDocument): void {
    if (!this.sourceUri || doc.uri.toString() !== this.sourceUri.toString()) {
      return;
    }
    const block = this.findTrackedBlock(doc);
    if (!block) {
      return; // the block was (temporarily) deleted mid-edit — keep the last good render
    }
    this.showBlock(doc, block);
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
    const block = this.findTrackedBlock(doc);
    if (block && block.supported) {
      this.renderBlock(doc, block);
    }
  }

  /**
   * Locate the block we're tracking in a (re-parsed) document. Prefers the block
   * spanning sourceBlockStart; if edits above the fence shifted it out of range,
   * recover by re-pinning to the block nearest the last known start line — so an
   * edit above the diagram doesn't freeze the live preview.
   */
  private findTrackedBlock(doc: vscode.TextDocument): MermaidBlock | undefined {
    const direct = getBlockAtLine(doc, this.sourceBlockStart);
    if (direct) {
      return direct;
    }
    const blocks = getBlocks(doc);
    if (blocks.length === 0) {
      return undefined;
    }
    return blocks.reduce((best, b) =>
      Math.abs(b.startLine - this.sourceBlockStart) < Math.abs(best.startLine - this.sourceBlockStart) ? b : best
    );
  }

  /** Show a block: render it if supported, else the unsupported notice. Either
   *  way, TRACK it (uri + start line) so a later live edit re-targets the right
   *  block and an unsupported block isn't overwritten by a stale supported one. */
  private showBlock(doc: vscode.TextDocument, block: MermaidBlock): void {
    this.sourceUri = doc.uri;
    this.sourceBlockStart = block.startLine;
    if (block.supported) {
      this.renderBlock(doc, block);
    } else {
      this.send({
        type: 'state',
        kind: 'unsupported',
        text: `Preview supports flowcharts (graph / flowchart). “${block.diagramType}” isn't supported in v1.`,
      });
    }
  }

  private renderBlock(doc: vscode.TextDocument, block: MermaidBlock): void {
    this.sourceUri = doc.uri;
    this.sourceBlockStart = block.startLine;
    this.panel.title = `Preview ${doc.uri.path.split('/').pop() ?? ''}`;
    const code = buildDiagramSource(doc.getText(), isMmd(doc), block.startLine, block.endLine);
    // key identifies "the same diagram" so the webview keeps zoom/pan across a
    // live-edit re-render but fits fresh when you switch to a different block.
    const key = `${doc.uri.toString()}#${block.startLine}`;
    this.send({ type: 'render', code, id: 'm' + ++this.renderSeq, key });
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
