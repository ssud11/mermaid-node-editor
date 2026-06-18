// Utility shim: re-exports the block-finding API from mermaid-node-core and
// retains the three helpers that the extension/MCP use but the core does not
// expose publicly (scanNodes, RESERVED, hasOverBracketedShape).
//
// Block-finding (findMermaidBlocks / blockAtLine) now goes through the
// grammar-backed PEG parser in mermaid-node-core. The utilities below are
// extension-side logic that intentionally stays here.

// ---- Types ------------------------------------------------------------------
// Kept here so every extension/MCP import site continues to see concrete types.
// The core uses plain JS (no .d.ts yet). Until a hand-written declaration file
// is added, TS infers `any` for values that come back from the core, so we
// declare the types here and expose them through the typed wrappers below.

export type Quote = '' | '"' | "'";

export interface MermaidNode {
  id: string;
  label: string;
  line: number;
  startChar: number;
  endChar: number;
  labelStart: number;
  labelEnd: number;
  open: string;
  close: string;
  quote: Quote;
  // `raw` is NOT present on nodes returned by the core parser. All callers
  // that previously used node.raw have been ported to structural derivations.
}

export interface MermaidSubgraph {
  id: string;
  label: string;
  line: number;
  // `indent` is NOT present on subgraphs returned by the core parser.
  // computeSubgraphLabelEdit derives indent directly from the lines array.
  hasId: boolean;
  quote: Quote;
  idStart: number;
  idEnd: number;
  members: string[];
}

export type EdgeStroke = 'solid' | 'dotted' | 'thick';
export type EdgeHead = 'arrow' | 'open' | 'circle' | 'cross';

export interface EdgeKind {
  stroke: EdgeStroke;
  head: EdgeHead;
  bidirectional: boolean;
}

export interface MermaidEdge {
  from: string;
  to: string;
  line: number;
  label?: string;
  // The core stores stroke/head/bidirectional as FLAT fields on the edge
  // (no nested EdgeKind object). The MCP output layer (tools.ts) wraps them
  // back into the nested form to preserve the MCP response contract.
  // The extension sidebar never reads edge.kind directly.
  kind: EdgeKind;
}

export interface MermaidBlock {
  startLine: number;
  endLine: number;
  contentStart: number;
  contentEnd: number;
  diagramType: string;
  supported: boolean;
  nodes: MermaidNode[];
  subgraphs: MermaidSubgraph[];
  edges: MermaidEdge[];
}

// ---- Core block API (re-exported with concrete types) -----------------------
// The core is a plain-JS ESM module; we load it via require() (esbuild handles
// ESM→CJS at bundle time) and re-export with TypeScript signatures so callers
// stay fully typed.

/* eslint-disable @typescript-eslint/no-require-imports */
// Load the core. Resolution approach:
//   - esbuild bundles: the coreResolvePlugin in esbuild.config.js intercepts
//     any path containing 'mermaid-node-core' and redirects to the absolute
//     path of the core's index.js — the literal here is irrelevant at bundle time.
//   - tsc + node --test: `require.resolve` walks from __dirname at runtime, so
//     the compiled output file's directory is used. We locate the core by
//     searching parent directories for 'mermaid-node-core' from __filename.
//     Using `node:module` createRequire on the closest package.json isn't portable,
//     so we use a small runtime search instead.
// In an esbuild bundle, `__MNE_BUNDLE__` is defined `true`, so core is INLINED via a
// STATIC specifier the core-remap plugin intercepts — the packaged build excludes the
// core source tree, so it MUST be inlined, never resolved at runtime. esbuild constant-
// folds the guard and DCE-drops the parent-dir walk below.
declare const __MNE_BUNDLE__: boolean | undefined;
function _loadCore(): {
  findMermaidBlocks: (text: string, isMmd: boolean) => MermaidBlock[];
  blockAtLine: (blocks: MermaidBlock[], line: number, isMmd: boolean) => MermaidBlock | undefined;
} {
  // Bundle path: a STATIC require the esbuild core-remap plugin (filter
  // /mermaid-node-core/) intercepts and inlines. `typeof` is safe when undefined.
  if (typeof __MNE_BUNDLE__ !== 'undefined') {
    return require('../../mermaid-node-core/src/index.js');
  }
  // tsc + node:test: no bundler — walk parent dirs from the compiled file location
  // (../../ from out/src and ../../../ from mcp/out/src both reach the project root).
  const literals = [
    '../../mermaid-node-core/src/index.js',
    '../../../mermaid-node-core/src/index.js',
    '../../../../mermaid-node-core/src/index.js',
  ];
  const nodePath = require('node:path') as typeof import('node:path');
  for (const rel of literals) {
    const abs = nodePath.resolve(__dirname, rel);
    try {
      return require(abs);
    } catch {
      // not found at this depth, try next
    }
  }
  throw new Error(
    `mermaid-node-core not found from ${__dirname}. ` +
      `Run 'npm run build:parser' in the mermaid-node-core directory first.`
  );
}
const _core = _loadCore();
/* eslint-enable @typescript-eslint/no-require-imports */

/** Find every Mermaid flowchart block in a document (core parser). */
export const findMermaidBlocks: (text: string, isMmd: boolean) => MermaidBlock[] =
  _core.findMermaidBlocks;

/** Pick the block containing a given line. */
export const blockAtLine: (
  blocks: MermaidBlock[],
  line: number,
  isMmd: boolean
) => MermaidBlock | undefined = _core.blockAtLine;

// ---- Utilities retained from the original parser ----------------------------

// Bracket shapes, longest open token first so `([` matches before `(`.
const OPEN_TO_CLOSE: Record<string, string> = {
  '([': '])',
  '[[': ']]',
  '[(': ')]',
  '((': '))',
  '{{': '}}',
  '[': ']',
  '(': ')',
  '{': '}',
  '>': ']',
};

// id immediately followed by one of the opening bracket tokens.
const ID_OPEN_RE = /([A-Za-z0-9_]+)(\(\[|\[\[|\[\(|\(\(|\{\{|\[|\(|\{|>)/g;

/**
 * Find every node definition on a single line. A definition is an id directly
 * followed by a bracketed label, e.g. `A[Start]`, `B(("Round"))`, `C{Decision}`.
 */
export function scanNodes(line: string, lineNumber: number): MermaidNode[] {
  const nodes: MermaidNode[] = [];
  ID_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ID_OPEN_RE.exec(line)) !== null) {
    const id = m[1];
    const open = m[2];
    const idStart = m.index;

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
        continue;
      }
      const idx = line.indexOf(close, qEnd + 1);
      if (idx === -1 || line.slice(qEnd + 1, idx).trim() !== '') {
        continue;
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
      open,
      close,
      quote,
    });
    ID_OPEN_RE.lastIndex = endChar;
  }
  return nodes;
}

/** Mermaid keywords that are NOT valid node ids. */
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

/**
 * True when a node uses an over-long opening-bracket run (`(((`, `[[[`, `{{{`)
 * that is not a supported Mermaid shape. Derived structurally from node.open
 * and node.label (the core no longer provides node.raw).
 *
 * The scanner greedily matches the 2-char open (`((`) so for a `(((` run:
 *   open = `((`, label starts with `(`.
 * Detect by checking whether the label begins with the same bracket character
 * as the open token.
 */
export function hasOverBracketedShape(node: Pick<MermaidNode, 'open' | 'label'>): boolean {
  if (!node.open) return false;
  const leakChar = node.open[0];
  return node.open.length === 2 && node.label.startsWith(leakChar);
}
