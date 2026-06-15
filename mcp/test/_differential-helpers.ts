// Shared helpers for the cross-surface differential harness (QA-1).
// Not a *.test.ts file, so the runner glob (out/mcp/test/*.test.js) skips it.
import { findMermaidBlocks } from '../../src/parser';
import { computeIdRename, computeLabelEdit, type TextEditDesc } from '../../src/editor';
import { applyEdits } from '../src/apply-edits';

/** Core rename edits (parse → computeIdRename); [] if the core declines. */
export function renameEdits(text: string, oldId: string, newId: string): TextEditDesc[] {
  const block = findMermaidBlocks(text, true)[0];
  const r = computeIdRename(block, text.split(/\r?\n/), oldId, newId);
  return r.ok ? r.edits : [];
}

/** Production pure pipeline: parse → computeIdRename → MCP applyEdits. Throws if the core declines. */
export function renameViaCore(text: string, oldId: string, newId: string): string {
  const block = findMermaidBlocks(text, true)[0];
  const r = computeIdRename(block, text.split(/\r?\n/), oldId, newId);
  if (!r.ok) throw new Error(r.error);
  return applyEdits(text, r.edits);
}

/** Like renameViaCore but returns null instead of throwing when the core declines. */
export function tryRenameViaCore(text: string, oldId: string, newId: string): string | null {
  const block = findMermaidBlocks(text, true)[0];
  const r = computeIdRename(block, text.split(/\r?\n/), oldId, newId);
  return r.ok ? applyEdits(text, r.edits) : null;
}

/** Production pure relabel pipeline. Throws if the core declines. */
export function relabelViaCore(text: string, id: string, newLabel: string): string {
  const block = findMermaidBlocks(text, true)[0];
  const r = computeLabelEdit(block, id, newLabel);
  if (!r.ok) throw new Error(r.error);
  return applyEdits(text, r.edits);
}

/** Sorted `from->to` edge keys of the first block. */
export function edgesOf(text: string): string[] {
  return findMermaidBlocks(text, true)[0].edges.map((e) => `${e.from}->${e.to}`).sort();
}

/**
 * INDEPENDENT reference applier — maps per-line edits to ABSOLUTE string offsets
 * using real EOL lengths, then splices the whole string right-to-left. A
 * different mechanism from applyEdits' per-line approach, so agreement
 * cross-validates the offset + EOL math.
 */
export function applyEditsRef(text: string, edits: TextEditDesc[]): string {
  if (edits.length === 0) return text;
  const parts = text.split(/(\r\n|\n)/); // [content, eol, content, eol, …, content]
  const lineStart: number[] = [];
  let off = 0;
  for (let i = 0; i < parts.length; i += 2) {
    lineStart.push(off);
    off += parts[i].length + (parts[i + 1] ? parts[i + 1].length : 0);
  }
  const abs = edits
    .filter((e) => lineStart[e.line] !== undefined)
    .map((e) => ({ start: lineStart[e.line] + e.startChar, end: lineStart[e.line] + e.endChar, newText: e.newText }))
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of abs) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}
