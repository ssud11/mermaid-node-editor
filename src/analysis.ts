// Read-only analysis over a parsed Mermaid block: locate the tag under a cursor,
// find a tag's declaration and all its references, and detect duplicate-tag
// declarations (one tag bound to two different elements).
//
// Pure and vscode-free like parser.ts / editor.ts, so it unit-tests in plain
// Node. The vscode language providers (definition/reference/rename) and the
// diagnostics layer are thin wrappers over these functions.

import { MermaidBlock, MermaidNode, scanNodes } from './parser';
import { protectedRanges } from './editor';

/**
 * Turn a raw parser error into a short, plain-English hint. Falls back to the
 * raw message unchanged for anything unmapped — callers keep the raw text
 * alongside (verbose in brackets / below) so the exact token is still available.
 */
export function friendlyParseError(raw: string | undefined): string {
  const m = raw ?? '';
  const reserved = m.match(/reserved Mermaid keyword "([^"]+)"/);
  if (reserved) {
    return `\`${reserved[1]}\` is a reserved word in Mermaid — rename it or wrap the label in quotes.`;
  }
  // The grammar expected a closing bracket sequence to finish a node shape —
  // `]`, `)`, `}`, or a two-char closer like `))`, `])`, `}}`, `]]`, `)]`.
  const closer = m.match(/Expected\s+"([\])}]{1,3})"/);
  if (closer) return `Unclosed shape — add the closing \`${closer[1]}\`.`;
  if (/Expected\s+.*"flowchart".*"graph"/.test(m)) return "This line isn't valid flowchart syntax.";
  return m;
}

export interface Loc {
  line: number;
  startChar: number;
  endChar: number; // exclusive — the span of the id token
}

export type TagKind = 'node' | 'subgraph' | 'ref';

export interface TagHit extends Loc {
  id: string;
  kind: TagKind; // what the cursor is sitting on (a declaration vs a bare reference)
}

export interface Declaration extends Loc {
  id: string;
  kind: 'node' | 'subgraph';
}

export interface DuplicateGroup {
  id: string;
  reason: 'duplicate-node' | 'duplicate-subgraph' | 'node-and-subgraph';
  message: string;
  locations: Loc[];
}

const IDENT = /[A-Za-z0-9_]+/g;
const DIRECTIVE = /^(graph|flowchart)\b/i;
const DIRECTION = /^direction\b/i; // `direction TD` — a keyword line, not tags
const STYLING = /^(style|classDef|linkStyle|click)\b/i; // CSS values / classes / URLs, not tags

/**
 * The first line of diagram BODY content (the line with `graph`/`flowchart`, or
 * the first content line after YAML frontmatter). The core does not advance
 * `block.contentStart` past frontmatter, so callers that need to skip frontmatter
 * (analysis + findDuplicates) use this instead of `block.contentStart` as the
 * lower bound for line-scanning.
 *
 * Frontmatter is a `--- … ---` block at the very start of the content range.
 * If no frontmatter is present the result equals `block.contentStart`.
 */
function bodyStart(block: MermaidBlock, lines: string[]): number {
  const { contentStart, contentEnd } = block;
  // Skip leading blank / comment lines.
  let i = contentStart;
  while (i < contentEnd && (lines[i]?.trim() === '' || lines[i]?.trim().startsWith('%%'))) {
    i++;
  }
  if (i >= contentEnd || lines[i]?.trim() !== '---') {
    return contentStart; // no frontmatter
  }
  // Advance past the closing `---`.
  let j = i + 1;
  while (j < contentEnd && lines[j]?.trim() !== '---') {
    j++;
  }
  if (j >= contentEnd) {
    return contentStart; // unterminated — treat as no frontmatter
  }
  return j + 1; // first line after the closing `---`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inRange(start: number, end: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}

/** Every id known in the block (declarations + bare edge references). */
export function collectIds(block: MermaidBlock): Set<string> {
  const ids = new Set<string>();
  for (const n of block.nodes) ids.add(n.id);
  for (const s of block.subgraphs) ids.add(s.id);
  for (const e of block.edges) {
    ids.add(e.from);
    ids.add(e.to);
  }
  return ids;
}

/**
 * The tag (id) under a cursor position, or undefined if the cursor isn't on a
 * known tag (e.g. it's on a keyword, a label word, or inside an arrow operator).
 */
export function findTagAtPosition(
  block: MermaidBlock,
  lines: string[],
  line: number,
  char: number
): TagHit | undefined {
  const text = lines[line];
  if (text === undefined) {
    return undefined;
  }
  // Only tags inside the diagram body are navigable — not frontmatter, the
  // markdown fence, the diagram directive, or `direction` keyword lines.
  const start = bodyStart(block, lines);
  if (line < start || line >= block.contentEnd) {
    return undefined;
  }
  const trimmed = text.trim();
  if (DIRECTIVE.test(trimmed) || DIRECTION.test(trimmed) || STYLING.test(trimmed)) {
    return undefined;
  }

  // Identifier token covering the cursor.
  IDENT.lastIndex = 0;
  let token: { id: string; start: number; end: number } | undefined;
  let m: RegExpExecArray | null;
  while ((m = IDENT.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (char >= start && char <= end) {
      token = { id: m[0], start, end };
      break;
    }
  }
  if (!token) {
    return undefined;
  }
  if (!collectIds(block).has(token.id)) {
    return undefined; // a keyword / label word / unrelated identifier
  }

  // On a subgraph declaration line, only the subgraph id is a tag — title words
  // (including unquoted free-text titles) are never references.
  const sgOnLine = block.subgraphs.find((s) => s.line === line);
  if (sgOnLine) {
    if (sgOnLine.hasId && sgOnLine.id === token.id && sgOnLine.idStart === token.start) {
      return { id: token.id, kind: 'subgraph', line, startChar: token.start, endChar: token.end };
    }
    return undefined;
  }

  if (inRange(token.start, token.end, protectedRanges(text))) {
    return undefined; // inside a label / quoted string / arrow operator
  }

  // Declaration occurrence vs a bare edge reference.
  const node = block.nodes.find((n) => n.id === token!.id && n.line === line && n.startChar === token!.start);
  return {
    id: token.id,
    kind: node ? 'node' : 'ref',
    line,
    startChar: token.start,
    endChar: token.end,
  };
}

/**
 * The declaration of a tag (its bracketed node definition or `subgraph id [..]`).
 * Returns undefined for an id that only appears as a bare edge reference.
 */
export function findDeclaration(block: MermaidBlock, id: string): Declaration | undefined {
  const node = block.nodes.find((n) => n.id === id);
  if (node) {
    return { id, kind: 'node', line: node.line, startChar: node.startChar, endChar: node.startChar + id.length };
  }
  // Match an id-less (`subgraph "Title"`) subgraph too — its id IS its title, and
  // idStart/idEnd point at the title token — so the read API reports declaration.kind
  // 'subgraph' for it (the discriminator consumers use to spot a phase container),
  // not null. (Renaming a subgraph id is still gated separately on hasId.)
  const sg = block.subgraphs.find((s) => s.id === id);
  if (sg) {
    return { id, kind: 'subgraph', line: sg.line, startChar: sg.idStart, endChar: sg.idEnd };
  }
  return undefined;
}

/**
 * Every occurrence of a tag across the block — its declaration plus all edge
 * references — skipping occurrences inside labels / quoted strings / arrows and
 * the diagram directive line. `includeDeclaration` mirrors VS Code's reference
 * context flag.
 */
export function findReferences(
  block: MermaidBlock,
  lines: string[],
  id: string,
  includeDeclaration = true
): Loc[] {
  const decl = findDeclaration(block, id);
  const out: Loc[] = [];
  const re = new RegExp(`\\b${escapeRegExp(id)}\\b`, 'g');
  for (let ln = bodyStart(block, lines); ln < block.contentEnd; ln++) {
    const text = lines[ln];
    if (text === undefined) {
      continue;
    }
    const trimmed = text.trim();
    // Keyword + styling lines carry no tag references we own (a node named TD must
    // not match the `direction TD` keyword, nor `graph LR`, nor a CSS value inside
    // a `style`/`classDef`/`linkStyle`/`click` statement).
    if (DIRECTIVE.test(trimmed) || DIRECTION.test(trimmed) || STYLING.test(trimmed)) {
      continue;
    }
    // On a subgraph declaration line the only tag is the subgraph id itself —
    // never words inside the (possibly unquoted, free-text) title.
    const sgOnLine = block.subgraphs.find((s) => s.line === ln);
    if (sgOnLine) {
      if (sgOnLine.hasId && sgOnLine.id === id) {
        const isDecl = !!decl && decl.line === ln && decl.startChar === sgOnLine.idStart;
        if (!(isDecl && !includeDeclaration)) {
          out.push({ line: ln, startChar: sgOnLine.idStart, endChar: sgOnLine.idEnd });
        }
      }
      continue;
    }
    const ranges = protectedRanges(text);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (inRange(start, end, ranges)) {
        continue;
      }
      const isDecl = !!decl && decl.line === ln && decl.startChar === start;
      if (isDecl && !includeDeclaration) {
        continue;
      }
      out.push({ line: ln, startChar: start, endChar: end });
    }
  }
  return out;
}

/**
 * Detect tags bound to two *different* elements (the "one tag = one element"
 * rule): the same id given two different node labels/shapes, two `subgraph`s
 * with the same id, or an id used for both a node and a subgraph. Bare edge
 * references are NOT flagged — using a tag isn't redefining it.
 */
export function findDuplicateDeclarations(block: MermaidBlock, lines: string[]): DuplicateGroup[] {
  // All node declarations, including repeats (the block collapses them to first).
  const nodeDecls: MermaidNode[] = [];
  for (let i = bodyStart(block, lines); i < block.contentEnd; i++) {
    const raw = lines[i];
    if (raw === undefined) {
      continue;
    }
    const t = raw.trim();
    if (t === '' || t.startsWith('%%') || /^end\b/.test(t) || /^subgraph\b/i.test(t)) {
      continue;
    }
    nodeDecls.push(...scanNodes(raw, i));
  }

  const groups: DuplicateGroup[] = [];

  // Same id, two different node labels/shapes.
  const byNodeId = new Map<string, MermaidNode[]>();
  for (const n of nodeDecls) {
    (byNodeId.get(n.id) ?? byNodeId.set(n.id, []).get(n.id)!).push(n);
  }
  for (const [id, decls] of byNodeId) {
    const distinct = decls.some((d) => d.label !== decls[0].label || d.open !== decls[0].open);
    if (decls.length > 1 && distinct) {
      groups.push({
        id,
        reason: 'duplicate-node',
        message: `Tag "${id}" is defined more than once with different labels — Mermaid merges them into one node.`,
        locations: decls.map((d) => ({ line: d.line, startChar: d.startChar, endChar: d.startChar + id.length })),
      });
    }
  }

  // Two subgraphs with the same explicit id.
  const bySgId = new Map<string, typeof block.subgraphs>();
  for (const s of block.subgraphs) {
    if (!s.hasId) {
      continue;
    }
    (bySgId.get(s.id) ?? bySgId.set(s.id, []).get(s.id)!).push(s);
  }
  for (const [id, sgs] of bySgId) {
    if (sgs.length > 1) {
      groups.push({
        id,
        reason: 'duplicate-subgraph',
        message: `Subgraph id "${id}" is declared more than once.`,
        locations: sgs.map((s) => ({ line: s.line, startChar: s.idStart, endChar: s.idEnd })),
      });
    }
  }

  // Same id used for both a node declaration and a subgraph.
  const nodeIds = new Set(nodeDecls.map((n) => n.id));
  for (const [id, sgs] of bySgId) {
    if (nodeIds.has(id)) {
      const locs: Loc[] = [];
      for (const n of nodeDecls.filter((n) => n.id === id)) {
        locs.push({ line: n.line, startChar: n.startChar, endChar: n.startChar + id.length });
      }
      for (const s of sgs) {
        locs.push({ line: s.line, startChar: s.idStart, endChar: s.idEnd });
      }
      groups.push({
        id,
        reason: 'node-and-subgraph',
        message: `Tag "${id}" is used for both a node and a subgraph.`,
        locations: locs,
      });
    }
  }

  return groups;
}
