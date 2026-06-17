// Write-back logic for node/subgraph edits.
//
// Like the parser, this is intentionally vscode-free: each function returns a
// list of `TextEditDesc` (line + column span + replacement text). The webview
// panel converts these to vscode.Range + WorkspaceEdit and applies them. This
// keeps the load-bearing rename/relabel logic unit-testable in plain Node.

import { MermaidBlock, MermaidNode, RESERVED, scanNodes, hasOverBracketedShape } from './parser';

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
  // A bare node (no brackets) being given a label MUST gain brackets, else the id and
  // label fuse into one token (`Alpha` relabelled to `Gamma` -> `AlphaGamma`).
  const open = node.open || '[';
  const close = node.close || ']';
  return `${newId}${open}${wrapped}${close}`;
}

/** Change a node's label, preserving its id and bracket shape. */
export function computeLabelEdit(block: MermaidBlock, nodeId: string, newLabel: string): EditResult {
  // Harden the pure API for direct (untyped JS) callers — needsQuoting/buildNodeRaw
  // call .trim()/.replace() on newLabel and throw on null/undefined. (Unreachable via
  // the MCP server [Zod] or the webview panel [coercion], which already guard this.)
  if (typeof (newLabel as unknown) !== 'string') {
    return { ok: false, edits: [], error: 'Label must be a string.' };
  }
  const node = block.nodes.find((n) => n.id === nodeId);
  if (!node) {
    // The id may be referenced only by edges (a bare endpoint, never bracket-declared)
    // — there is no label to edit until it has a shape. flow_query reports such an id
    // as found:true (via collectIds), so give a clearer message than "not found".
    const isBareRef = block.edges.some((e) => e.from === nodeId || e.to === nodeId);
    const error = isBareRef
      ? `"${nodeId}" is referenced by edges but has no declared label to edit — give it a shape first (e.g. ${nodeId}[Label]).`
      : `Node "${nodeId}" not found in this diagram.`;
    return { ok: false, edits: [], error };
  }
  // An over-bracketed shape (`(((`, `[[[`, `{{{`) mis-parses: the scanner captured the
  // 2-char open + a label with a leaked bracket, so a rebuilt node would leave the
  // extra closing bracket as residue (`done(((x)))` -> `done((New)))`). Refuse rather
  // than corrupt — the shape is unsupported; fix it to a documented shape first (R14-2).
  if (hasOverBracketedShape(node)) {
    return { ok: false, edits: [], error: `"${nodeId}" uses an unsupported bracket shape (e.g. \`(((\`); a relabel would corrupt the source — change it to a documented shape (e.g. \`((${nodeId}))\`) first.` };
  }
  // A raw line break inside a label corrupts the source (splices a newline inside the
  // bracket, so the node + its edges vanish on re-parse). Mermaid uses <br/>, not \n.
  if (/[\r\n]/.test(newLabel)) {
    return { ok: false, edits: [], error: 'Label cannot contain a line break (use <br/> for a visual break).' };
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
  // `A -. t .-> B`, and the glued `A --text--> B`): protect the inner <text> so an
  // id-like word in the label prose is never rewritten during an id rename. The
  // opening operator carries a `(?![>xo])` lookahead so it is NOT an arrowhead —
  // that keeps a chained `A --> B --> C` from treating B as label text. The inner
  // whitespace is optional (\s*) so a label abutting its operator is still caught.
  const inlineLabelRe = /(?<=^|\s)([<xo]?[-.=]{2,}(?![>xo])\s*)(.+?)(\s*[-.=]{2,}[>xo]?)(?=\s|$)/g;
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
  // Defense-in-depth: an empty oldId makes `\b\b` a zero-width match whose lastIndex
  // never advances → infinite loop. Nothing to rename anyway. (computeIdRename also
  // guards this, but renameIdInLine is exported and called directly elsewhere.)
  if (oldId === '') {
    return line;
  }
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
    // A hyphen immediately adjacent means oldId is a FRAGMENT of a hyphenated compound
    // (`receive-order` — our id charset [A-Za-z0-9_] doesn't own the `-`, so the parser
    // truncated it). Rewriting the fragment would corrupt the compound; leave it.
    if (line[start - 1] === '-' || line[end] === '-') {
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
  // Harden the pure API for untyped JS callers — a non-string id would coerce to the
  // literal 'null'/'undefined' inside the regexes. (Symmetric with computeLabelEdit;
  // unreachable via the MCP server [Zod] / panel.)
  if (typeof (oldId as unknown) !== 'string' || typeof (newId as unknown) !== 'string') {
    return { ok: false, edits: [], error: 'oldId and newId must be strings.' };
  }
  if (newId === oldId) {
    return { ok: true, edits: [] };
  }
  // oldId must be a valid id too. An empty/invalid oldId reaches renameIdInLine,
  // where `\b${oldId}\b` collapses to the zero-width `/\b\b/g` that matches without
  // ever advancing lastIndex → an infinite loop. server.ts's safe() wrapper only
  // catches throws, so that loop HANGS the MCP server. Reject oldId symmetrically.
  if (!ID_RE.test(oldId)) {
    return { ok: false, edits: [], error: `Invalid id "${oldId}". Use letters, digits and underscores only.` };
  }
  if (!ID_RE.test(newId)) {
    return { ok: false, edits: [], error: `Invalid id "${newId}". Use letters, digits and underscores only.` };
  }
  // A reserved Mermaid keyword as an id makes its line start with that keyword, and
  // the parser drops keyword-led lines — silently losing the node + its edges. Reject.
  if (RESERVED.has(newId)) {
    return { ok: false, edits: [], error: `Id "${newId}" is a reserved Mermaid keyword — its line would be dropped by the parser. Choose another id.` };
  }
  // Subgraph ids are read-only in v1: the `subgraph` declaration line is
  // intentionally never rewritten, so renaming one would rename its edge
  // references while orphaning the declaration. Reject it here so EVERY caller
  // (sidebar + F2 rename) is safe, matching the read-only sidebar subgraph field.
  if (block.subgraphs.some((s) => s.hasId && s.id === oldId)) {
    return { ok: false, edits: [], error: `"${oldId}" is a subgraph id — renaming subgraph ids isn't supported in v1 (edit its title instead).` };
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
  // oldId must actually be a STRUCTURAL id (a node, subgraph, or edge endpoint).
  // If it appears only inside a %% comment (or nowhere), there is nothing to rename —
  // reject rather than "succeed" by rewriting comment prose, which reports a false
  // green to the caller (the rename never touched the graph). The parser already
  // excludes %% lines from nodes/edges, so a comment-only id is absent from usedIds.
  if (!usedIds.has(oldId)) {
    return { ok: false, edits: [], error: `Id "${oldId}" not found in this diagram.` };
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
    // The diagram directive (`graph TD`), `direction` lines, and subgraph
    // declarations carry keywords / titles, not node references — never rewrite
    // ids there. (Frontmatter is already excluded: block.contentStart sits past
    // it.) This stops a node named `TD`/`LR` from clobbering a `direction TD` line.
    // These keyword-line guards MUST match the parser's RESERVED test (parser.ts),
    // which is case-SENSITIVE (lowercase only). The parser treats a capitalised id
    // like `Graph`/`Subgraph`/`Direction`/`ClassDef`/`LinkStyle` as a real NODE, so a
    // `/i` flag here would skip that line and silently drop the rename — corrupting the
    // source with a false-green ok:true (R14-1). Hence NO `/i`.
    if (
      /^(graph|flowchart)\b/.test(trimmed) ||
      /^direction\b/.test(trimmed) ||
      /^subgraph\b/.test(trimmed) ||
      // The bare `end` subgraph closer is a keyword line, not a node ref — never
      // rewrite it, or renaming a node that happens to be named `end` corrupts the
      // closer and leaves the subgraph unclosed. Mirrors the parser's closer test.
      /^end\s*($|;|%%)/.test(trimmed) ||
      // %% lines are Mermaid comments — prose, not node refs. Skip them so a real
      // id mentioned in a comment isn't rewritten (and the comment-only case above
      // is already rejected).
      /^%%/.test(trimmed) ||
      // classDef / linkStyle statements carry class names + CSS values (not node
      // refs we own) — never rewrite ids inside them.
      /^(classDef|linkStyle)\b/.test(trimmed)
    ) {
      continue;
    }
    // `style <id> …` and `click <id> …` LEAD with a real node reference, then CSS /
    // a callback / a URL. Rename only that leading id token so the directive follows
    // its node through the rename (otherwise it dangles on the dead id); leave the
    // rest of the line untouched — running renameIdInLine over the whole line could
    // rewrite an id-like token inside the CSS value or the quoted URL.
    const styleClick = /^(\s*(?:style|click)\s+)([A-Za-z0-9_]+)(.*)$/i.exec(original);
    if (styleClick) {
      if (styleClick[2] === oldId) {
        edits.push({ line: ln, startChar: 0, endChar: original.length, newText: `${styleClick[1]}${newId}${styleClick[3]}` });
      }
      continue;
    }
    // `class <id-list> <className>` assigns nodes to a CSS class. The leading
    // comma-separated ids are node refs (rename them); the trailing class name is a
    // classDef ref, NOT a node — renaming it would orphan it from its classDef. (The
    // bare `class` line is not in the skip-list above precisely so we handle it here.)
    // The id-list may use spaces around commas (`class A, B, C myClass`), so match a
    // comma-chain that tolerates surrounding whitespace; the className still lands in
    // group 3 (a non-comma-joined trailing token) and is never renamed.
    const classDirective = /^(\s*class\s+)([A-Za-z0-9_]+(?:\s*,\s*[A-Za-z0-9_]+)*)(\s.*)?$/i.exec(original);
    if (classDirective) {
      // Rename each id token in place so whitespace + commas are preserved exactly.
      const ids = classDirective[2].replace(/[A-Za-z0-9_]+/g, (tok) => (tok === oldId ? newId : tok));
      if (ids !== classDirective[2]) {
        edits.push({ line: ln, startChar: 0, endChar: original.length, newText: `${classDirective[1]}${ids}${classDirective[3] ?? ''}` });
      }
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
  if (typeof (newLabel as unknown) !== 'string') {
    return { ok: false, edits: [], error: 'Subgraph title must be a string.' };
  }
  const sg = block.subgraphs.find((s) => s.id === subgraphId);
  if (!sg) {
    return { ok: false, edits: [], error: `Subgraph "${subgraphId}" not found.` };
  }
  // Same corruption as a node label: a raw line break splices a newline into the
  // subgraph declaration line. Reject it (matches computeLabelEdit).
  if (/[\r\n]/.test(newLabel)) {
    return { ok: false, edits: [], error: 'Subgraph title cannot contain a line break (use <br/> for a visual break).' };
  }
  if (sg.label === newLabel) {
    return { ok: true, edits: [] };
  }
  // A bare-title subgraph (no id) has no brackets to delimit the title, so a
  // multi-word title must be quoted — otherwise `subgraph Three Word Title` parses
  // with only `Three` as the id. (A titled-with-id subgraph wraps the title in
  // `[ ]`, where spaces are already safe, so it only quotes on real syntax chars.)
  const needsQ = needsQuoting(newLabel) || (!sg.hasId && /\s/.test(newLabel));
  const wrapped = needsQ ? `"${newLabel.replace(/"/g, '#quot;')}"` : newLabel;
  const newLine = sg.hasId
    ? `${sg.indent}subgraph ${sg.id} [${wrapped}]`
    : `${sg.indent}subgraph ${wrapped}`;
  const original = lines[sg.line] ?? sg.raw;
  return {
    ok: true,
    edits: [{ line: sg.line, startChar: 0, endChar: original.length, newText: newLine }],
  };
}
