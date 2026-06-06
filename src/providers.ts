// VS Code language providers for Mermaid tags: Go to Definition, Find References,
// and Rename. Thin wrappers over the pure analysis layer — each resolves the tag
// under the cursor, then defers to analysis.ts / editor.ts. Works in `.mmd` files
// and inside ```mermaid blocks in markdown (gated via getBlockAtLine).

import * as vscode from 'vscode';
import { MermaidBlock } from './parser';
import { findTagAtPosition, findDeclaration, findReferences, TagHit } from './analysis';
import { computeIdRename } from './editor';
import { getBlockAtLine, isSupportedDoc } from './webview/panel';

/** The Mermaid block + tag under a cursor, or undefined if there isn't one. */
function tagAt(
  document: vscode.TextDocument,
  position: vscode.Position
): { block: MermaidBlock; lines: string[]; tag: TagHit } | undefined {
  if (!isSupportedDoc(document)) {
    return undefined;
  }
  // For markdown this returns a block only when the cursor is inside a ```mermaid
  // fence, which gates these providers to mermaid content automatically.
  const block = getBlockAtLine(document, position.line);
  if (!block || !block.supported) {
    return undefined;
  }
  const lines = document.getText().split(/\r?\n/);
  const tag = findTagAtPosition(block, lines, position.line, position.character);
  if (!tag) {
    return undefined;
  }
  return { block, lines, tag };
}

export class MermaidDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Definition | undefined {
    const hit = tagAt(document, position);
    if (!hit) {
      return undefined;
    }
    const decl = findDeclaration(hit.block, hit.tag.id);
    if (!decl) {
      return undefined; // an id used only as a bare edge ref has no declaration
    }
    return new vscode.Location(
      document.uri,
      new vscode.Range(decl.line, decl.startChar, decl.line, decl.endChar)
    );
  }
}

export class MermaidReferenceProvider implements vscode.ReferenceProvider {
  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext
  ): vscode.Location[] | undefined {
    const hit = tagAt(document, position);
    if (!hit) {
      return undefined;
    }
    return findReferences(hit.block, hit.lines, hit.tag.id, context.includeDeclaration).map(
      (l) => new vscode.Location(document.uri, new vscode.Range(l.line, l.startChar, l.line, l.endChar))
    );
  }
}

export class MermaidRenameProvider implements vscode.RenameProvider {
  // Only allow rename when the cursor is actually on a tag (gives a clean error
  // otherwise instead of renaming arbitrary words).
  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Range | { range: vscode.Range; placeholder: string } {
    const hit = tagAt(document, position);
    if (!hit) {
      throw new Error('Not a Mermaid tag — place the cursor on a node or subgraph id.');
    }
    // Subgraph ids are read-only in v1 (matches the disabled sidebar field).
    if (hit.block.subgraphs.some((s) => s.hasId && s.id === hit.tag.id)) {
      throw new Error('Renaming subgraph ids is not supported in v1 — edit the subgraph title instead.');
    }
    return {
      range: new vscode.Range(hit.tag.line, hit.tag.startChar, hit.tag.line, hit.tag.endChar),
      placeholder: hit.tag.id,
    };
  }

  provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ): vscode.WorkspaceEdit {
    const hit = tagAt(document, position);
    if (!hit) {
      throw new Error('Not a Mermaid tag.');
    }
    // Same engine as the sidebar ID field — one rename core, shared collision guard.
    const result = computeIdRename(hit.block, hit.lines, hit.tag.id, newName);
    if (!result.ok) {
      throw new Error(result.error ?? 'Rename failed.');
    }
    const edit = new vscode.WorkspaceEdit();
    for (const e of result.edits) {
      edit.replace(document.uri, new vscode.Range(e.line, e.startChar, e.line, e.endChar), e.newText);
    }
    return edit;
  }
}
