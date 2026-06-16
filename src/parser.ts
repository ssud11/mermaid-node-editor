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
  idStart: number; // start column of the id/title token on the line
  idEnd: number; // end column (exclusive) of the id/title token
  members: string[]; // ids (nodes + nested subgraphs) declared directly inside this subgraph, in document order
}

export type EdgeStroke = 'solid' | 'dotted' | 'thick';
export type EdgeHead = 'arrow' | 'open' | 'circle' | 'cross';

export interface EdgeKind {
  stroke: EdgeStroke; // line style: `--` solid, `-.-` dotted, `==` thick
  head: EdgeHead; // arrowhead at the `to` end: `>` arrow, none `open`, `o` circle, `x` cross
  bidirectional: boolean; // a matching head at the `from` end too (`<-->`, `o--o`, `x--x`)
}

export interface MermaidEdge {
  from: string;
  to: string;
  line: number;
  label?: string; // edge label — pipe `-->|x|` or inline `-- x -->`, trimmed; undefined if none
  kind: EdgeKind;
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

  // Column where the content after the `subgraph` keyword begins (the id/title).
  let cs = indent.length + 'subgraph'.length;
  while (cs < line.length && /\s/.test(line[cs])) {
    cs++;
  }

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
      idStart: cs,
      idEnd: cs + withBracket[1].length,
      members: [],
    };
  }

  // `subgraph "Title"` / `subgraph 'Title'`
  if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) {
    const inner = stripQuotes(rest);
    return { id: inner.value, label: inner.value, line: lineNumber, indent, raw: line, hasId: false, quote: inner.quote, idStart: cs, idEnd: cs + rest.length, members: [] };
  }

  // `subgraph plainId`
  if (ID_TOKEN.test(rest)) {
    return { id: rest, label: rest, line: lineNumber, indent, raw: line, hasId: true, quote: '', idStart: cs, idEnd: cs + rest.length, members: [] };
  }

  // `subgraph Some free text title`
  if (rest.length > 0) {
    return { id: rest, label: rest, line: lineNumber, indent, raw: line, hasId: false, quote: '', idStart: cs, idEnd: cs + rest.length, members: [] };
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

// One Mermaid link operator, with an optional inline label and/or trailing pipe
// label. Two alternatives, inline tried first: the inline-label form
// (`-- text -->`, `== t ==>`, `-. t .->`, glued `--text-->`) whose opening
// operator is NOT itself an arrowhead (`(?![>xo])`), and the plain/arrow form
// (`-->`, `---`, `--x`, `<-->`, `==>`, `-.->`). Group 1 = the operator (incl. any
// inline label); group 2 = a trailing `|pipe label|`.
const LINK_RE =
  /([<xo]?[-.=]{2,}(?![>xo])\s*.+?\s*[-.=]{2,}[>xo]?|[<xo]?[-.=]{2,}[>xo]?)(?:\s*\|([^|]*)\|)?/g;

// Split a line into Mermaid statements on `;`, but NOT on a `;` inside a `|pipe
// label|` (toggling on each `|`). `;` separates statements (`A-->B; C-->D`);
// without per-statement parsing a trailing `;` drops the edge and two statements
// synthesize a spurious cross-edge.
function splitStatements(s: string): string[] {
  const out: string[] = [];
  let inPipe = false;
  let cur = '';
  for (const ch of s) {
    if (ch === '|') {
      inPipe = !inPipe;
    }
    if (ch === ';' && !inPipe) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const headOf = (c: string): EdgeHead | undefined =>
  c === '>' ? 'arrow' : c === 'o' ? 'circle' : c === 'x' ? 'cross' : undefined;

// Decode one link operator into its kind (stroke/head/bidirectional) + label.
function decodeLink(op: string, pipe: string | undefined): { kind: EdgeKind; label?: string; reversed: boolean } {
  const stroke: EdgeStroke = op.includes('=') ? 'thick' : op.includes('.') ? 'dotted' : 'solid';
  const tailHead = headOf(op[op.length - 1]); // arrowhead at the `to` end
  const leadHead =
    op[0] === '<' ? 'arrow' : op[0] === 'o' ? 'circle' : op[0] === 'x' ? 'cross' : undefined;
  // A left-pointing-only operator (`<--`, `<==`, `o--`) reverses the edge: the head is
  // at the LEAD end and the caller swaps from/to to match Mermaid (`B <-- C` means C→B).
  // Bidirectional (`<-->`) keeps both ends and is NOT reversed.
  const reversed = !!leadHead && !tailHead;
  const head: EdgeHead = (reversed ? leadHead : tailHead) ?? 'open';
  // Bidirectional connectors exist only in SOLID form (`<-->`, `o--o`, `x--x`).
  // `<==>` / `o..o` etc. are not valid Mermaid — don't report them as bidirectional.
  const bidirectional = !!leadHead && !!tailHead && stroke === 'solid';

  // Label: prefer the pipe form; else pull an inline `<op> text <op>` label out of
  // the operator. (A plain `-->` has no inner text, so the inline match fails.)
  let label = pipe?.trim();
  if (label === undefined) {
    const inline = /^[<xo]?[-.=]{2,}\s*(.+?)\s*[-.=]{2,}[>xo]?$/.exec(op);
    // Require a real (non-operator) character in the candidate: a length-variant
    // dotted/thick arrow like `-...->` otherwise false-matches and yields a phantom
    // `.` label (the dot count only changes arrow length, it is not a label).
    if (inline && /[^-.=<>xo\s]/.test(inline[1])) {
      label = inline[1].trim();
    }
  }
  // Mermaid strips a surrounding quote pair from an edge label, but ONLY when the
  // whole label is one quoted run (`"hello world"`). A label like `"a" "b"` or
  // `a "b" c` keeps its quotes.
  if (label !== undefined) {
    const q = /^"([^"]*)"$/.exec(label) || /^'([^']*)'$/.exec(label);
    if (q) {
      label = q[1];
    }
  }
  return { kind: { stroke, head, bidirectional }, label: label || undefined, reversed };
}

function parseEdges(line: string, lineNumber: number, nodes: MermaidNode[]): MermaidEdge[] {
  const skeleton = edgeSkeleton(line, nodes); // node defs collapsed to their ids; labels kept
  const edges: MermaidEdge[] = [];
  const idOrNone = (seg: string): string | undefined => {
    const t = seg.trim();
    return ID_TOKEN.test(t) ? t : undefined;
  };
  for (const stmt of splitStatements(skeleton)) {
    LINK_RE.lastIndex = 0;
    const links: { op: string; pipe: string | undefined; start: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(stmt)) !== null) {
      if (m[0] === '') {
        LINK_RE.lastIndex++; // never advance on a zero-width match
        continue;
      }
      links.push({ op: m[1], pipe: m[2], start: m.index, end: m.index + m[0].length });
    }
    // The ids are the gaps around the links: ids[0] before the first link, the
    // segment between links[i-1] and links[i] is shared as link[i-1].to / link[i].from
    // (so `A --> B --> C` chains correctly), ids[last] after the final link.
    for (let i = 0; i < links.length; i++) {
      const fromSeg = stmt.slice(i === 0 ? 0 : links[i - 1].end, links[i].start);
      const toSeg = stmt.slice(links[i].end, i === links.length - 1 ? undefined : links[i + 1].start);
      const from = idOrNone(fromSeg);
      const to = idOrNone(toSeg);
      if (from && to) {
        const { kind, label, reversed } = decodeLink(links[i].op, links[i].pipe);
        // For a reversed (left-pointing) arrow, the textual from/to are backwards.
        const [src, dst] = reversed ? [to, from] : [from, to];
        edges.push({ from: src, to: dst, line: lineNumber, label, kind });
      }
    }
  }
  return edges;
}

// The inner spans of edge labels on a line — pipe `|text|` and inline `-- text -->`
// — so node scanning can ignore node-shape syntax that appears INSIDE a label
// (`-->|check(x)|` must not register `check` as a node).
function edgeLabelRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  const pipeRe = /\|([^|]*)\|/g;
  while ((m = pipeRe.exec(line)) !== null) {
    const innerStart = m.index + 1;
    ranges.push([innerStart, innerStart + m[1].length]);
  }
  const inlineRe = /(?<=^|\s)([<xo]?[-.=]{2,}(?![>xo])\s*)(.+?)(\s*[-.=]{2,}[>xo]?)(?=\s|$)/g;
  while ((m = inlineRe.exec(line)) !== null) {
    const innerStart = m.index + m[1].length;
    ranges.push([innerStart, innerStart + m[2].length]);
  }
  return ranges;
}

// Mermaid keywords that are NOT node ids — so a bare keyword line isn't mistaken
// for a bare-node declaration.
export const RESERVED = new Set([
  'graph',
  'flowchart',
  'subgraph',
  'end',
  'direction',
  'click',
  'class',
  'classDef',
  'style',
  'linkStyle',
  'default',
]);

// Strip an inline `%% ...` comment, but ONLY at a `%%` that is OUTSIDE every node
// label / quoted string / pipe label — so a `%%` *inside* a label (`A["x %% y"]`,
// `-->|a %% b|`) is left intact. (Mermaid officially allows only own-line comments;
// this stays lenient for a trailing inline `%%` without corrupting label text.)
function stripComment(line: string): string {
  const protectedSpans: Array<[number, number]> = [];
  for (const n of scanNodes(line, 0)) {
    protectedSpans.push([n.labelStart, n.labelEnd]);
  }
  let m: RegExpExecArray | null;
  const quoteRe = /"[^"]*"|'[^']*'/g;
  while ((m = quoteRe.exec(line)) !== null) {
    protectedSpans.push([m.index, m.index + m[0].length]);
  }
  // Edge-label inner spans — pipe `|..|` AND inline `-- .. -->` — so a `%%` inside
  // any edge label is never treated as a comment start.
  for (const span of edgeLabelRanges(line)) {
    protectedSpans.push(span);
  }
  const ccRe = /%%/g;
  while ((m = ccRe.exec(line)) !== null) {
    const at = m.index;
    if (!protectedSpans.some(([s, e]) => at >= s && at < e)) {
      return line.slice(0, at).replace(/\s+$/, '');
    }
  }
  return line;
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

  // Skip a leading YAML frontmatter block (`--- ... ---`) that Mermaid allows
  // before the diagram keyword (title:/config:/id:). Advance contentStart PAST it
  // so node scanning AND the analysis/edit layers (which iterate
  // contentStart..contentEnd) never treat frontmatter as diagram content — e.g. a
  // node named `id` must not collide with a `id: <uuid>` frontmatter key. Without
  // the skip the opening `---` is also taken as the diagram type and a valid
  // flowchart is wrongly marked unsupported.
  let first = block.contentStart;
  while (first < contentEnd && (lines[first].trim() === '' || lines[first].trim().startsWith('%%'))) {
    first++;
  }
  if (first < contentEnd && lines[first].trim() === '---') {
    let j = first + 1;
    while (j < contentEnd && lines[j].trim() !== '---') {
      j++;
    }
    if (j >= contentEnd) {
      return block; // unterminated frontmatter — malformed; leave unsupported
    }
    block.contentStart = j + 1;
  }

  // First meaningful content line decides the diagram type.
  for (let i = block.contentStart; i < contentEnd; i++) {
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
  // Subgraph membership: a stack of currently-open subgraphs (innermost last) and a
  // block-wide set of ids already "seen". An id belongs to the subgraph where it is
  // DECLARED (a node-definition / bare-id line); an id that is only ever an edge
  // reference takes the subgraph of its first reference. So a real declaration RE-HOMES
  // an id that an earlier forward edge reference had tentatively claimed — otherwise a
  // node declared in a later phase but referenced from an earlier one (the standard
  // multi-phase pattern) would be mis-assigned to the referencing phase.
  const open: MermaidSubgraph[] = [];
  const seen = new Set<string>();
  const refClaim = new Map<string, MermaidSubgraph | null>(); // ids claimed via a bare ref
  const claim = (id: string, isDeclaration: boolean): void => {
    const sg = open.length > 0 ? open[open.length - 1] : null;
    if (seen.has(id)) {
      // A declaration is authoritative: move the id off the subgraph an earlier bare
      // edge reference put it on, onto the one it's actually declared in (or out).
      if (isDeclaration && refClaim.has(id)) {
        const prev = refClaim.get(id) ?? null;
        refClaim.delete(id);
        if (prev !== sg) {
          if (prev) prev.members = prev.members.filter((m) => m !== id);
          if (sg) sg.members.push(id);
        }
      }
      return;
    }
    seen.add(id);
    if (!isDeclaration) refClaim.set(id, sg);
    if (sg) sg.members.push(id);
  };

  for (let i = block.contentStart; i < contentEnd; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('%%')) {
      continue;
    }
    // A subgraph closer is the bare keyword `end` (optionally `;` or a trailing
    // comment). `end[...]` / `end(...)` / `end{...}` is a node literally NAMED `end`
    // (a reserved id, skipped later by the RESERVED guard) — it must NOT pop the
    // stack here, which would close the subgraph early and silently drop the rest of
    // its nodes/edges while flow_validate still reports ok.
    if (/^end\s*($|;|%%)/.test(trimmed)) {
      open.pop(); // close the innermost subgraph
      continue;
    }

    const sg = parseSubgraph(raw, i);
    if (sg) {
      claim(sg.id, true); // the subgraph itself is a member of its parent (declared here)
      block.subgraphs.push(sg);
      open.push(sg);
      continue; // don't treat a subgraph title as nodes/edges
    }

    // Directive lines (`style`/`click`/`classDef`/`linkStyle`/`direction`/…) are
    // their own Mermaid grammar productions, never node/edge declarations — skip
    // them BEFORE node scanning so bracket-like values (`rgb(255,0,0)`,
    // `myFunc(arg)`) aren't mis-parsed as nodes. (The diagram-type line is skipped
    // here too; it carries no nodes/edges.)
    const firstToken = /^\s*([A-Za-z0-9_]+)/.exec(raw);
    if (firstToken && RESERVED.has(firstToken[1])) {
      continue;
    }

    // Strip an inline `%% ...` comment (Mermaid begins a comment at `%%` and runs
    // to end of line) so a trailing comment doesn't break id extraction / drop the edge.
    const parseLine = stripComment(raw);

    // A node "definition" that falls INSIDE an edge label (`-->|check(x)|`,
    // `-- a[b] -->`) is label text, not a node — drop it.
    const labelRanges = edgeLabelRanges(parseLine);
    const lineNodes = scanNodes(parseLine, i).filter(
      (n) => !labelRanges.some(([s, e]) => n.startChar >= s && n.startChar < e)
    );
    for (const n of lineNodes) {
      if (!nodesById.has(n.id)) {
        nodesById.set(n.id, n);
      }
    }
    const lineEdges = parseEdges(parseLine, i, lineNodes);
    block.edges.push(...lineEdges);
    // Claim membership in document order: node DEFINITIONS first (authoritative —
    // they own the id's subgraph), then edge endpoints as bare REFERENCES (which only
    // claim an id not yet declared, and are re-homed if a later declaration appears).
    for (const n of lineNodes) {
      claim(n.id, true);
    }
    for (const e of lineEdges) {
      claim(e.from, false);
      claim(e.to, false);
    }

    // A bare identifier alone on a line (`A`) is a valid Mermaid node declaration
    // even without a bracketed shape — capture it for the node list + membership.
    if (lineNodes.length === 0 && lineEdges.length === 0) {
      const bare = /^(\s*)([A-Za-z0-9_]+)\s*$/.exec(parseLine);
      if (bare && !RESERVED.has(bare[2])) {
        const id = bare[2];
        const startChar = bare[1].length;
        if (!nodesById.has(id)) {
          nodesById.set(id, {
            id,
            label: id,
            line: i,
            startChar,
            endChar: startChar + id.length,
            labelStart: startChar,
            labelEnd: startChar + id.length,
            raw: id,
            open: '',
            close: '',
            quote: '',
          });
        }
        claim(id, true); // a bare id on its own line is a declaration
      }
    }
  }

  block.nodes = [...nodesById.values()];
  return block;
}

// A markdown code-fence line: 3+ backticks (or tildes), then an optional info
// string (first non-space token decides the language).
const FENCE = /^(\s*)(`{3,}|~{3,})\s*(\S*)/;

/**
 * Find every Mermaid block in a document.
 *  - `.mmd` / `.mermaid` (isMmd=true): the whole file is one block.
 *  - markdown (isMmd=false): each fenced ```mermaid ... ``` block.
 *
 * The markdown scan is fence-aware: it walks code fences and skips their
 * CONTENT, so a ```mermaid that is itself nested inside an outer fence (e.g. a
 * ````markdown example) is not mistaken for a live diagram, and an UNTERMINATED
 * ```mermaid fence does not swallow the rest of the file (which would otherwise
 * let a write-back rewrite ordinary prose). A closing fence must use the same
 * marker and be at least as long as the opener (CommonMark).
 */
export function findMermaidBlocks(text: string, isMmd: boolean): MermaidBlock[] {
  const lines = text.split(/\r?\n/);

  if (isMmd) {
    return [buildBlock(lines, 0, 0, lines.length, Math.max(0, lines.length - 1))];
  }

  const blocks: MermaidBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    const fenceChar = open[2][0]; // '`' or '~'
    const len = open[2].length;
    const info = open[3].toLowerCase();
    const closeRe = new RegExp('^\\s*' + fenceChar + '{' + len + ',}\\s*$');
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) {
      j++;
    }
    if (j >= lines.length) {
      // Unterminated fence — not a valid block. Skip only this opener line so a
      // stray fence cannot capture the remainder of the document.
      i++;
      continue;
    }
    if (info === 'mermaid') {
      blocks.push(buildBlock(lines, i, i + 1, j, j));
    }
    i = j + 1; // resume after the closing fence (its content is consumed)
  }
  return blocks;
}

/**
 * Pick the block containing a given line. For `.mmd` the whole file is one block,
 * so the first (only) block is always returned. Pure counterpart of the panel's
 * cursor→block lookup so providers/diagnostics can share it.
 */
export function blockAtLine(blocks: MermaidBlock[], line: number, isMmd: boolean): MermaidBlock | undefined {
  if (isMmd) {
    return blocks[0];
  }
  return blocks.find((b) => line >= b.startLine && line <= b.endLine);
}
