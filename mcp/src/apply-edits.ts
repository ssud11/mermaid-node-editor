// Apply a parser/editor `TextEditDesc[]` to plain document text — the pure
// counterpart of the VS Code extension's WorkspaceEdit path. Used by the write
// tools (flow_rename / flow_relabel) to produce the edited text without a host.
import type { TextEditDesc } from '../../src/editor';

/**
 * Apply edits to `text` and return the new text. Edits are per-line
 * {line, startChar, endChar (exclusive), newText}; within a line they are applied
 * right-to-left so earlier offsets stay valid. Each line keeps its ORIGINAL
 * terminator, so a mixed-EOL file is never silently normalized — only edited
 * spans change. Line indexing matches the parser's /\r?\n/ split (a lone \r is
 * line content, not a break).
 */
export function applyEdits(text: string, edits: TextEditDesc[]): string {
  if (edits.length === 0) {
    return text;
  }
  // Split keeping separators: parts = [content, eol, content, eol, …, content].
  const parts = text.split(/(\r\n|\n)/);
  const lines: string[] = [];
  const eols: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i]);
    eols.push(parts[i + 1] ?? '');
  }
  const byLine = new Map<number, TextEditDesc[]>();
  for (const e of edits) {
    const arr = byLine.get(e.line) ?? [];
    arr.push(e);
    byLine.set(e.line, arr);
  }
  for (const [lineNo, lineEdits] of byLine) {
    if (lineNo < 0 || lineNo >= lines.length) {
      continue;
    }
    let line = lines[lineNo];
    // Right-to-left so a splice doesn't shift the offsets of edits left of it.
    for (const e of [...lineEdits].sort((a, b) => b.startChar - a.startChar)) {
      line = line.slice(0, e.startChar) + e.newText + line.slice(e.endChar);
    }
    lines[lineNo] = line;
  }
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    out += lines[i] + eols[i];
  }
  return out;
}
