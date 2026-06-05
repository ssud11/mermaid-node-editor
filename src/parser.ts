// Mermaid flowchart parser (v1).
//
// Pure and vscode-free on purpose: it operates on plain strings + line/column
// numbers so it can be unit-tested in plain Node and reused by the write-back
// layer. Parsing is regex line-by-line (NOT the mermaid npm AST) per the v1
// build plan — flowcharts only (`graph`/`flowchart`).

export type Quote = '' | '"' | "'";

export interface MermaidNode {
  id: string;
  label: string;
  line: number; // 0-based absolute line in the document
  startChar: number; // start column of the raw node text (the id)
  endChar: number; // end column (exclusive) of the raw node text
  labelStart: number; // start column of the label *content* (inside quotes)
  labelEnd: number; // end column (exclusive) of the label content
  raw: string; // original text, e.g. 'A[Session open]'
  open: string; // opening bracket token, e.g. '[' or '([' or '{{'
  close: string; // matching closing bracket token, e.g. ']' or '])'
  quote: Quote; // quote char wrapping the label, '' if unquoted
}

export interface MermaidSubgraph {
  id: string;
  label: string;
  line: number;
  indent: string;
  raw: string;
  hasId: boolean; // false when written as `subgraph "Title"` (no explicit id)
  quote: Quote;
}

export interface MermaidEdge {
  from: string;
  to: string;
  line: number;
}

export interface MermaidBlock {
  startLine: number; // line of the ```mermaid fence (0 for .mmd)
  endLine: number; // line of the closing ``` (last line for .mmd)
  contentStart: number; // first line of diagram content
  contentEnd: number; // one past the last content line (exclusive)
  diagramType: string; // e.g. 'graph TD', 'flowchart LR', or the raw first line
  supported: boolean; // false for non-flowchart diagram types (v1 scope)
  nodes: MermaidNode[];
  subgraphs: MermaidSubgraph[];
  edges: MermaidEdge[];
}

// Bracket shapes, longest-open-token first so e.g. `([` matches before `(`.
const OPEN_TO_CLOSE: Record<string, string> = {
  '([': '])',
  '[[': ']]',
  '[(': ')]',
  '((': '))',
  '{{': '}}',
  '[': ']',
  '(': ')',
  '{': '}',
  '>': ']', // asymmetric node `A>label]`
};

// id immediately followed by one of the opening bracket tokens (multi-char first).
const ID_OPEN_RE = /([A-Za-z0-9_]+)(\(\[|\[\[|\[\(|\(\(|\{\{|\[|\(|\{|>)/g;

const ID_TOKEN = /^[A-Za-z0-9_]+$/;

/**
 * Find every node *definition* on a single line. A definition is an id directly
 * followed by a bracketed label, e.g. `A[Start]`, `B(("Round"))`, `C{Decision}`.
 * Bare id references (in edges) are not definitions and are not returned here.
 */
export function scanNodes(line: string, lineNumber: number): MermaidNode[] {
  const nodes: MermaidNode[] = [];
  ID_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ID_OPEN_RE.exec(line)) !== null) {
    const id = m[1];
    const open = m[2];
    const idStart = m.index;

    // Reject if the id is actually the tail of a longer identifier.
    if (idStart > 0 && /[A-Za-z0-9_]/.test(line[idStart - 1])) {
      ID_OPEN_RE.lastIndex = idStart + id.length;
      continue;
    }

    const close = OPEN_TO_CLOSE[open];
    if (!close) {
      continue;
    }

    const afterOpen = idStart + id.length + open.length;
    const first = line[afterOpen];
    let quote: Quote = '';
    let contentStart: number;
    let contentEnd: number;
    let closeAt: number;
    let label: string;

    if (first === '"' || first === "'") {
      quote = first;
      const qEnd = line.indexOf(quote, afterOpen + 1);
      if (qEnd === -1) {
        continue; // unterminated quote
      }
      const idx = line.indexOf(close, qEnd + 1);
      if (idx === -1 || line.slice(qEnd + 1, idx).trim() !== '') {
        continue; // close token missing or stray text between quote and close
      }
      contentStart = afterOpen + 1;
      contentEnd = qEnd;
      closeAt = idx;
      label = line.slice(contentStart, contentEnd);
    } else {
      const idx = line.indexOf(close, afterOpen);
      if (idx === -1) {
        continue;
      }
      contentStart = afterOpen;
      contentEnd = idx;
      closeAt = idx;
      label = line.slice(contentStart, contentEnd);
    }

    const endChar = closeAt + close.length;
    nodes.push({
      id,
      label,
      line: lineNumber,
      startChar: idStart,
      endChar,
      labelStart: contentStart,
      labelEnd: contentEnd,
      raw: line.slice(idStart, endChar),
      open,
      close,
      quote,
    });
    ID_OPEN_RE.lastIndex = endChar;
  }
  return nodes;
}

function stripQuotes(text: string): { value: string; quote: Quote } {
  const t = text.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return { value: t.slice(1, -1), quote: t[0] as Quote };
  }
  return { value: t, quote: '' };
}

function parseSubgraph(line: string, lineNumber: number): MermaidSubgraph | undefined {
  const m = /^(\s*)subgraph\b\s*(.*)$/.exec(line);
  if (!m) {
    return undefined;
  }
  const indent = m[1];
  const rest = m[2].trim();

  // `subgraph id [Title]`
  const withBracket = /^([A-Za-z0-9_]+)\s*\[(.*)\]\s*$/.exec(rest);
  if (withBracket) {
    const inner = stripQuotes(withBracket[2]);
    return {
      id: withBracket[1],
      label: inner.value,
      line: lineNumber,
      indent,
      raw: line,
      hasId: true,
      quote: inner.quote,
    };
  }

  // `subgraph "Title"` / `subgraph 'Title'`
  if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) {
    const inner = stripQuotes(rest);
    return { id: inner.value, label: inner.value, line: lineNumber, indent, raw: line, hasId: false, quote: inner.quote };
  }

  // `subgraph plainId`
  if (ID_TOKEN.test(rest)) {
    return { id: rest, label: rest, line: lineNumber, indent, raw: line, hasId: true, quote: '' };
  }

  // `subgraph Some free text title`
  if (rest.length > 0) {
    return { id: rest, label: rest, line: lineNumber, indent, raw: line, hasId: false, quote: '' };
  }

  return undefined;
}

// Build a "skeleton" of a line where every node definition is collapsed to its
// id, so edge detection isn't confused by bracketed label text.
function edgeSkeleton(line: string, nodes: MermaidNode[]): string {
  let out = '';
  let last = 0;
  for (const n of [...nodes].sort((a, b) => a.startChar - b.startChar)) {
    out += line.slice(last, n.startChar) + n.id;
    last = n.endChar;
  }
  out += line.slice(last);
  return out;
}

const ARROW_SPLIT = /\s*[<xo]?[-.=]{2,}[->xo]?\s*/;

function parseEdges(line: string, lineNumber: number, nodes: MermaidNode[]): MermaidEdge[] {
  let skeleton = edgeSkeleton(line, nodes);
  skeleton = skeleton.replace(/\|[^|]*\|/g, ' '); // drop |edge labels|
  const ids = skeleton
    .split(ARROW_SPLIT)
    .map((p) => p.trim())
    .filter((p) => ID_TOKEN.test(p));
  const edges: MermaidEdge[] = [];
  for (let k = 0; k < ids.length - 1; k++) {
    edges.push({ from: ids[k], to: ids[k + 1], line: lineNumber });
  }
  return edges;
}

function buildBlock(
  lines: string[],
  startLine: number,
  contentStart: number,
  contentEnd: number,
  endLine: number
): MermaidBlock {
  const block: MermaidBlock = {
    startLine,
    endLine,
    contentStart,
    contentEnd,
    diagramType: '',
    supported: false,
    nodes: [],
    subgraphs: [],
    edges: [],
  };

  // First meaningful content line decides the diagram type.
  for (let i = contentStart; i < contentEnd; i++) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('%%')) {
      continue;
    }
    const dt = /^(graph|flowchart)\b\s*([A-Za-z]{1,2})?/i.exec(t);
    block.diagramType = t;
    block.supported = !!dt;
    break;
  }

  if (!block.supported) {
    return block;
  }

  const nodesById = new Map<string, MermaidNode>();
  for (let i = contentStart; i < contentEnd; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('%%')) {
      continue;
    }
    if (/^end\b/.test(trimmed)) {
      continue;
    }

    const sg = parseSubgraph(raw, i);
    if (sg) {
      block.subgraphs.push(sg);
      continue; // don't treat a subgraph title as nodes/edges
    }

    const lineNodes = scanNodes(raw, i);
    for (const n of lineNodes) {
      if (!nodesById.has(n.id)) {
        nodesById.set(n.id, n);
      }
    }
    block.edges.push(...parseEdges(raw, i, lineNodes));
  }

  block.nodes = [...nodesById.values()];
  return block;
}

const FENCE_OPEN = /^\s*```+\s*mermaid\b.*$/i;
const FENCE_CLOSE = /^\s*```+\s*$/;

/**
 * Find every Mermaid block in a document.
 *  - `.mmd` / `.mermaid` (isMmd=true): the whole file is one block.
 *  - markdown (isMmd=false): each fenced ```mermaid ... ``` block.
 */
export function findMermaidBlocks(text: string, isMmd: boolean): MermaidBlock[] {
  const lines = text.split(/\r?\n/);

  if (isMmd) {
    return [buildBlock(lines, 0, 0, lines.length, Math.max(0, lines.length - 1))];
  }

  const blocks: MermaidBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FENCE_OPEN.test(lines[i])) {
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !FENCE_CLOSE.test(lines[j])) {
      j++;
    }
    const closing = Math.min(j, lines.length);
    blocks.push(buildBlock(lines, i, i + 1, closing, closing));
    i = j;
  }
  return blocks;
}
