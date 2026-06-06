// Write-back logic for node/subgraph edits.
//
// Like the parser, this is intentionally vscode-free: each function returns a
// list of `TextEditDesc` (line + column span + replacement text). The webview
// panel converts these to vscode.Range + WorkspaceEdit and applies them. This
// keeps the load-bearing rename/relabel logic unit-testable in plain Node.

import { MermaidBlock, MermaidNode, scanNodes } from './parser';

export interface TextEditDesc {
  line: number;
  startChar: number;
  endChar: number; // exclusive
  newText: string;
}

export interface EditResult {
  ok: boolean;
  edits: TextEditDesc[];
  error?: string;
}

const ID_RE = /^[A-Za-z0-9_]+$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mermaid label needs quoting if it contains syntax-significant characters. */
export function needsQuoting(label: string): boolean {
  return label === '' || label.trim() !== label || /[[\](){}|;"'#&<>]/.test(label);
}

/** Reconstruct a node's raw text (`id` + brackets + possibly-quoted label). */
export function buildNodeRaw(
  node: Pick<MermaidNode, 'open' | 'close' | 'quote'>,
  newId: string,
  newLabel: string
): string {
  let quote = node.quote;
  if (!quote && needsQuoting(newLabel)) {
    quote = '"';
  }
  let label = newLabel;
  if (quote === '"') {
    label = label.replace(/"/g, '#quot;');
  }
  const wrapped = quote ? `${quote}${label}${quote}` : label;
  return `${newId}${node.open}${wrapped}${node.close}`;
}

/** Change a node's label, preserving its id and bracket shape. */
export function computeLabelEdit(block: MermaidBlock, nodeId: string, newLabel: string): EditResult {
  const node = block.nodes.find((n) => n.id === nodeId);
  if (!node) {
    return { ok: false, edits: [], error: `Node "${nodeId}" not found in this diagram.` };
  }
  if (node.label === newLabel) {
    return { ok: true, edits: [] };
  }
  const newText = buildNodeRaw(node, node.id, newLabel);
  return { ok: true, edits: [{ line: node.line, startChar: node.startChar, endChar: node.endChar, newText }] };
}

type Range = [number, number]; // [start, end) within a line

function overlaps(start: number, end: number, ranges: Range[]): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}

/** Spans on a line where an id token must NOT be treated as a reference. */
export function protectedRanges(line: string): Range[] {
  const ranges: Range[] = [];
  for (const n of scanNodes(line, 0)) {
    ranges.push([n.labelStart, n.labelEnd]); // node label content
  }
  const quoteRe = /"[^"]*"|'[^']*'/g; // any quoted string (e.g. click URLs)
  let q: RegExpExecArray | null;
  while ((q = quoteRe.exec(line)) !== null) {
    ranges.push([q.index, q.index + q[0].length]);
  }
  const pipeRe = /\|[^|]*\|/g; // |edge labels|
  let p: RegExpExecArray | null;
  while ((p = pipeRe.exec(line)) !== null) {
    ranges.push([p.index, p.index + p[0].length]);
  }
  // Inline edge labels in dash/dotted/thick form (`A -- text --> B`, `A == t ==> B`,
  // `A -. t .-> B`): protect the inner <text> so an id-like word in the label prose is
  // never rewritten during an id rename. Mirrors the pipe-form handling above.
  const inlineLabelRe = /(?<=^|\s)([<xo]?[-.=]{2,}\s+)(.+?)(\s+[-.=]{2,}[>xo]?)(?=\s|$)/g;
  let il: RegExpExecArray | null;
  while ((il = inlineLabelRe.exec(line)) !== null) {
    const innerStart = il.index + il[1].length;
    ranges.push([innerStart, innerStart + il[2].length]);
  }
  // Arrow operators (`-->`, `--x`, `--o`, `<--`, `==>`, …) — protect them so a
  // single-char id `x`/`o` is never rewritten inside an arrowhead.
  const arrowRe = /(?<=^|\s)[<xo]?[-.=]{2,}[>xo]?(?=\s|$)/g;
  let a: RegExpExecArray | null;
  while ((a = arrowRe.exec(line)) !== null) {
    ranges.push([a.index, a.index + a[0].length]);
  }
  return ranges;
}

/**
 * Replace whole-word occurrences of `oldId` with `newId` on a single line,
 * skipping any occurrence that falls inside a label / quoted string / edge label.
 * This covers the node definition itself plus all edge references.
 */
export function renameIdInLine(line: string, oldId: string, newId: string): string {
  const ranges = protectedRanges(line);
  const re = new RegExp(`\\b${escapeRegExp(oldId)}\\b`, 'g');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(start, end, ranges)) {
      continue;
    }
    out += line.slice(last, start) + newId;
    last = end;
  }
  out += line.slice(last);
  return out;
}

/**
 * Rename a node id across the whole block, propagating to every edge reference.
 * `lines` is the full document split into lines (so we can edit by absolute line).
 */
export function computeIdRename(
  block: MermaidBlock,
  lines: string[],
  oldId: string,
  newId: string
): EditResult {
  if (newId === oldId) {
    return { ok: true, edits: [] };
  }
  if (!ID_RE.test(newId)) {
    return { ok: false, edits: [], error: `Invalid id "${newId}". Use letters, digits and underscores only.` };
  }
  // Reject collisions with ANY id already in the block — including ids that
  // appear only as edge references (not just bracket-defined nodes/subgraphs).
  // Otherwise renaming onto a bare id silently merges two distinct nodes.
  const usedIds = new Set<string>();
  for (const n of block.nodes) usedIds.add(n.id);
  for (const s of block.subgraphs) usedIds.add(s.id);
  for (const e of block.edges) {
    usedIds.add(e.from);
    usedIds.add(e.to);
  }
  usedIds.delete(oldId);
  if (usedIds.has(newId)) {
    return { ok: false, edits: [], error: `Id "${newId}" already exists in this diagram.` };
  }

  const edits: TextEditDesc[] = [];
  for (let ln = block.contentStart; ln < block.contentEnd; ln++) {
    const original = lines[ln];
    if (original === undefined) {
      continue;
    }
    const trimmed = original.trim();
    // The diagram directive (`graph TD`) and subgraph declarations carry
    // keywords / titles, not node references — never rewrite ids there.
    if (/^(graph|flowchart)\b/i.test(trimmed) || /^subgraph\b/i.test(trimmed)) {
      continue;
    }
    const replaced = renameIdInLine(original, oldId, newId);
    if (replaced !== original) {
      edits.push({ line: ln, startChar: 0, endChar: original.length, newText: replaced });
    }
  }

  if (edits.length === 0) {
    return { ok: false, edits: [], error: `Id "${oldId}" not found in this diagram.` };
  }
  return { ok: true, edits };
}

/** Change a subgraph's title. Keeps the explicit id where one exists. */
export function computeSubgraphLabelEdit(
  block: MermaidBlock,
  lines: string[],
  subgraphId: string,
  newLabel: string
): EditResult {
  const sg = block.subgraphs.find((s) => s.id === subgraphId);
  if (!sg) {
    return { ok: false, edits: [], error: `Subgraph "${subgraphId}" not found.` };
  }
  if (sg.label === newLabel) {
    return { ok: true, edits: [] };
  }
  const wrapped = needsQuoting(newLabel) ? `"${newLabel.replace(/"/g, '#quot;')}"` : newLabel;
  const newLine = sg.hasId
    ? `${sg.indent}subgraph ${sg.id} [${wrapped}]`
    : `${sg.indent}subgraph ${wrapped}`;
  const original = lines[sg.line] ?? sg.raw;
  return {
    ok: true,
    edits: [{ line: sg.line, startChar: 0, endChar: original.length, newText: newLine }],
  };
}
