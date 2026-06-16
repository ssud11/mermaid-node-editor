// The six flow tools as PURE functions (no MCP types) so they unit-test directly.
// server.ts wires these to registerTool. All reuse the vscode-free parser/editor/
// analysis layer — no logic is duplicated here.
import { writeFileSync } from 'node:fs';
import { RESERVED, type MermaidBlock } from '../../src/parser';
import { computeIdRename, computeLabelEdit, computeSubgraphLabelEdit, type EditResult } from '../../src/editor';
import { collectIds, findDeclaration, findDuplicateDeclarations } from '../../src/analysis';
import { resolveSource, getBlocks, pickBlock, type FlowSource, type ResolvedSource } from './resolve';
import { applyEdits } from './apply-edits';
import { shapeOf } from './shapes';

const splitLines = (text: string): string[] => text.split(/\r?\n/);

// Uniform "no result" shape for flow_query — every early-return path returns the
// SAME keys as the normal path (null / [] placeholders) so an agent reading
// result.outgoing / .label / .incoming never hits an undefined on an error branch.
function emptyQuery(id: string, blockIndex: number | null, error: string) {
  return {
    id,
    found: false,
    blockIndex,
    label: null as string | null,
    declaration: null as { line: number; kind: string } | null,
    incoming: [] as Array<{ from: string; label: string | null; kind: string; line: number }>,
    outgoing: [] as Array<{ to: string; label: string | null; kind: string; line: number }>,
    subgraph: null as string | null,
    duplicateWarnings: [] as Array<{ reason: string; message: string }>,
    error,
  };
}

// `structuralPart(line)` blanks all node-label / quoted-string content (anything at
// bracket-depth > 0) to spaces, leaving only the depth-0 STRUCTURE — ids, link
// operators, `&`, hyphens. flow_validate's silent-drop probes run on this so a `&`,
// hyphen, or arrow-like sequence INSIDE a label is never mistaken for structure.
function structuralPart(line: string): string {
  let out = '';
  let depth = 0;
  let quote = '';
  for (const c of line) {
    if (quote) {
      out += ' ';
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      out += ' ';
      quote = c;
    } else if (c === '[' || c === '(' || c === '{') {
      out += ' ';
      depth++;
    } else if (c === ']' || c === ')' || c === '}') {
      out += ' ';
      depth = Math.max(0, depth - 1);
    } else {
      out += depth === 0 ? c : ' ';
    }
  }
  return out;
}

// True when a node label opens a quote (right after a shape bracket) that never closes
// on the same line — a multi-line label (literal newline inside quotes), which the
// line-by-line parser silently drops along with the node's edges.
function hasUnterminatedQuotedLabel(line: string): boolean {
  const re = /[[({]\s*(["'])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (line.indexOf(m[1], m.index + m[0].length) === -1) {
      return true; // this label's opening quote has no closing quote on the line
    }
  }
  return false;
}

// True when a line has an unmatched CLOSING bracket (more closers than openers,
// outside quotes) — e.g. a stray `]` inside an unquoted label closes the node early,
// so the rest of the line (its edge) is silently dropped. Runs on the RAW line because
// structuralPart() blanks every bracket and can't see the imbalance.
function hasPrematureBracketClose(line: string): boolean {
  let depth = 0;
  let quote = '';
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '[' || c === '(' || c === '{') {
      depth++;
    } else if ((c === ']' || c === ')' || c === '}') && --depth < 0) {
      return true;
    }
  }
  return false;
}

// ---- read tools ------------------------------------------------------------

export function flowOverview(src: FlowSource) {
  const r = resolveSource(src);
  const blocks = getBlocks(r);
  return {
    format: r.isMmd ? 'mmd' : 'markdown',
    blockCount: blocks.length,
    blocks: blocks.map((b, index) => {
      const froms = new Set(b.edges.map((e) => e.from));
      const tos = new Set(b.edges.map((e) => e.to));
      const allIds = collectIds(b);
      const sgIds = new Set(b.subgraphs.map((s) => s.id));
      // A subgraph id is a grouping CONTAINER unless it is itself a real edge endpoint
      // (`phase1 --> phase2`), in which case it participates in the flow and belongs in
      // entry/exit. Exclude only the pure containers (never an endpoint) — otherwise a
      // subgraph used as an endpoint vanishes from entry/exit and a walk stops early.
      const containerSgIds = new Set([...sgIds].filter((id) => !froms.has(id) && !tos.has(id)));
      return {
        index,
        diagramType: b.diagramType,
        supported: b.supported,
        lineRange: [b.startLine, b.endLine] as [number, number],
        // `nodes` counts every node id — INCLUDING bare edge-endpoint-only ids that
        // aren't in b.nodes — but excludes subgraph containers (counted separately).
        counts: { nodes: [...allIds].filter((id) => !sgIds.has(id)).length, edges: b.edges.length, subgraphs: b.subgraphs.length },
        entryNodes: b.supported ? [...allIds].filter((id) => !tos.has(id) && !containerSgIds.has(id)) : [],
        exitNodes: b.supported ? [...allIds].filter((id) => !froms.has(id) && !containerSgIds.has(id)) : [],
        subgraphs: b.subgraphs.map((s) => ({ id: s.id, title: s.label, members: s.members })),
      };
    }),
  };
}

function extractBlock(b: MermaidBlock, index: number) {
  return {
    index,
    diagramType: b.diagramType,
    supported: b.supported,
    nodes: b.nodes.map((n) => ({ id: n.id, label: n.label, shape: shapeOf(n.open), line: n.line })),
    edges: b.edges.map((e) => ({ from: e.from, to: e.to, label: e.label ?? null, kind: e.kind, line: e.line })),
    subgraphs: b.subgraphs.map((s) => ({ id: s.id, title: s.label, members: s.members })),
  };
}

export function flowExtract(src: FlowSource, blockIndex?: number) {
  const r = resolveSource(src);
  const blocks = getBlocks(r);
  if (blockIndex != null) {
    const b = blocks[blockIndex];
    return { blockCount: blocks.length, blocks: b ? [extractBlock(b, blockIndex)] : [] };
  }
  return { blockCount: blocks.length, blocks: blocks.map((b, i) => extractBlock(b, i)) };
}

export function flowQuery(src: FlowSource, id: string, blockIndex?: number) {
  // An untyped JS caller can merge the id into the src object ({text, id}), leaving the
  // positional id undefined — return a diagnostic instead of a silent found:false.
  if (id == null || id === '') {
    return emptyQuery(id, null, 'No node id provided — pass the id as the second argument, not inside the source object.');
  }
  const r = resolveSource(src);
  const blocks = getBlocks(r);
  const picked = pickBlock(blocks, blockIndex);
  if (!picked) {
    // Distinguish "you asked for block N but there are only M" from "no blocks at all".
    const msg =
      blockIndex != null && blocks.length > 0
        ? `block index ${blockIndex} is out of range (${blocks.length} block${blocks.length === 1 ? '' : 's'} in this source)`
        : 'no Mermaid block found';
    return emptyQuery(id, null, msg);
  }
  const { block, index } = picked;
  if (!block.supported) {
    return emptyQuery(id, index, `block ${index} is not a supported flowchart`);
  }
  const lines = splitLines(r.text);
  const decl = findDeclaration(block, id);
  const known = collectIds(block).has(id);
  const incoming = block.edges
    .filter((e) => e.to === id)
    .map((e) => ({ from: e.from, label: e.label ?? null, kind: e.kind, line: e.line }));
  const outgoing = block.edges
    .filter((e) => e.from === id)
    .map((e) => ({ to: e.to, label: e.label ?? null, kind: e.kind, line: e.line }));
  const subgraph = block.subgraphs.find((s) => s.members.includes(id))?.id ?? null;
  // The node's OWN label (declared nodes only; a bare/undeclared edge ref has none).
  // Lets a flow-walk read a node's label from this one call instead of a flow_extract
  // pre-pass. A subgraph id falls back to its title (the same lookup flow_extract /
  // flow_overview use) so a subgraph isn't reported with a null label.
  const label =
    block.nodes.find((n) => n.id === id)?.label ??
    block.subgraphs.find((s) => s.id === id)?.label ??
    null;
  const dups = findDuplicateDeclarations(block, lines).filter((d) => d.id === id);
  return {
    id,
    found: known,
    blockIndex: index,
    label,
    declaration: decl ? { line: decl.line, kind: decl.kind } : null,
    incoming,
    outgoing,
    subgraph,
    duplicateWarnings: dups.map((d) => ({ reason: d.reason, message: d.message })),
    // `error` is present on EVERY path (null on success / id-absent-in-valid-block;
    // a string on the no-block / unsupported-block paths via emptyQuery) so the
    // response shape is uniform — an agent discriminates on found + error, never on
    // which keys exist.
    error: null as string | null,
  };
}

interface Issue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  line?: number;
}

export function flowValidate(src: FlowSource) {
  const r = resolveSource(src);
  const blocks = getBlocks(r);
  if (blocks.length === 0) {
    return {
      ok: false,
      blocks: [] as Array<{ index: number; supported: boolean; issues: Issue[] }>,
      issues: [{ severity: 'error', code: 'no-block', message: 'no Mermaid block found' } as Issue],
    };
  }
  const lines = splitLines(r.text);
  const reports = blocks.map((b, index) => {
    const issues: Issue[] = [];
    if (!b.supported) {
      issues.push({
        severity: 'info',
        code: 'unsupported',
        message: `diagram type "${b.diagramType}" is not a supported flowchart (v1: graph/flowchart only)`,
        line: b.contentStart,
      });
      return { index, supported: false, issues };
    }
    for (const d of findDuplicateDeclarations(b, lines)) {
      issues.push({ severity: 'warning', code: d.reason, message: d.message, line: d.locations[0]?.line });
    }
    for (const n of b.nodes) {
      if (n.open !== '' && n.label.trim() === '') {
        issues.push({ severity: 'warning', code: 'empty-label', message: `node "${n.id}" has an empty label`, line: n.line });
      }
    }
    // Unreachable: a declared node that appears in no edge, when the block has edges.
    // Subgraph containers AND their declared members are intentionally grouped,
    // not orphaned — exclude both so they don't false-positive as unreachable.
    if (b.edges.length > 0) {
      const inEdges = new Set(b.edges.flatMap((e) => [e.from, e.to]));
      const sgIds = new Set(b.subgraphs.map((s) => s.id));
      const sgMembers = new Set(b.subgraphs.flatMap((s) => s.members));
      for (const n of b.nodes) {
        if (!inEdges.has(n.id) && !sgIds.has(n.id) && !sgMembers.has(n.id)) {
          issues.push({ severity: 'info', code: 'unreachable', message: `node "${n.id}" is declared but not connected by any edge`, line: n.line });
        }
      }
    }
    // Silent-drop probes: certain valid-looking Mermaid lines are skipped by the
    // line-by-line parser (the node/edge vanishes) while validate would otherwise stay
    // ok:true. Each probe turns that silent source loss into a visible warning. They
    // run on structuralPart() so a `&`/hyphen/arrow inside a label never false-triggers.
    for (let ln = b.contentStart; ln < b.contentEnd; ln++) {
      const line = lines[ln];
      if (line === undefined) continue;
      const t = line.trim();
      if (t === '' || t.startsWith('%%')) continue; // blank / comment lines aren't content
      const struct = structuralPart(line);
      // `&` fan-out/fan-in (`A --> B & C`) is not split in v1.
      if (/&/.test(struct) && /[-.=]{2,}/.test(struct)) {
        issues.push({ severity: 'warning', code: 'unsupported-fanout', message: 'edge fan-out/fan-in with "&" (e.g. `A --> B & C`) is not parsed in v1 — those edges are not represented; write them as separate edges', line: ln });
      }
      // A hyphen in an id position: v1 ids are [A-Za-z0-9_], so `receive-order` is
      // truncated to `order` and its edge is dropped. Use snake_case.
      if (/[A-Za-z0-9_]-[A-Za-z0-9_]/.test(struct)) {
        issues.push({ severity: 'warning', code: 'malformed-id', message: 'a node id appears to contain a hyphen ("-"); v1 ids are [A-Za-z0-9_] only, so the id is truncated and its edge dropped — use snake_case', line: ln });
      }
      // A reserved keyword used as a node id on an edge line: the parser skips the whole
      // line, so its edge and any node declared on it are not represented.
      const firstTok = /^\s*([A-Za-z0-9_]+)/.exec(line);
      if (firstTok && RESERVED.has(firstTok[1]) && /[-.=]{2,}[>ox]?/.test(struct)) {
        issues.push({ severity: 'warning', code: 'reserved-id-edge', message: `a line beginning with the reserved keyword "${firstTok[1]}" contains an edge; the line is skipped, so its edge and any node declared on it are not represented — rename the node`, line: ln });
      }
      // A reserved keyword used as a node DECLARATION — immediately followed by a shape
      // bracket (`end[End]`) — is dropped whole by the parser, so the node silently
      // vanishes even when its edge is on a separate line (which the edge probe misses).
      const reservedDecl = /^\s*([A-Za-z0-9_]+)[[({>]/.exec(line);
      if (reservedDecl && RESERVED.has(reservedDecl[1])) {
        issues.push({ severity: 'warning', code: 'reserved-id-dropped', message: `node id "${reservedDecl[1]}" is a reserved Mermaid keyword; its declaration is silently dropped — rename it (e.g. ${reservedDecl[1]}_node)`, line: ln });
      }
      // A label whose quote never closes on the line = a multi-line label; the node and
      // its edges on this line are dropped (v1 labels are single-line; use <br/>).
      if (hasUnterminatedQuotedLabel(line)) {
        issues.push({ severity: 'warning', code: 'multiline-label', message: 'a node label appears to span multiple lines (an unclosed quote); the node and its edges on this line are not parsed in v1 — keep the label on one line (use <br/> for a visual break)', line: ln });
      }
      // An unmatched closing bracket (e.g. a `]` inside an unquoted label) closes the
      // node early, dropping the rest of the line and its edge.
      if (hasPrematureBracketClose(line)) {
        issues.push({ severity: 'warning', code: 'unbalanced-bracket', message: 'an unmatched closing bracket (likely `]`/`)`/`}` inside an unquoted label) closes a node early — the rest of the line and its edge are dropped; quote the label or balance the brackets', line: ln });
      }
    }
    return { index, supported: true, issues };
  });
  // `ok` = there is at least one processable flowchart AND no error-severity issue.
  // A file of only unsupported diagrams (all blocks supported:false) is NOT ok —
  // mirroring the zero-block path so the flag never green-lights an unusable file.
  const ok = reports.some((br) => br.supported) && reports.every((br) => !br.issues.some((i) => i.severity === 'error'));
  // Always return a top-level `issues` array (file-level problems; empty here since
  // every issue in this branch is per-block) so the response shape is identical to
  // the zero-block branch — a client can always read both `issues` and `blocks`.
  return { ok, issues: [] as Issue[], blocks: reports };
}

// ---- write tools -----------------------------------------------------------

export interface WriteOpts {
  /** Block index to edit (default: first supported block). */
  block?: number;
  /** When true AND the source was a `path`, write the edited text back to disk. */
  write?: boolean;
}

function finishWrite(r: ResolvedSource, result: EditResult, newText: string, opts?: WriteOpts) {
  const changed = result.edits.length > 0;
  let written = false;
  let note: string | undefined;
  if (opts?.write) {
    if (r.path) {
      writeFileSync(r.path, newText, 'utf8');
      written = true;
    } else {
      note = 'write:true ignored — no `path` to write to (inline text); returning edited text only';
    }
  }
  return { ok: true, changed, editCount: result.edits.length, newText, written, path: r.path, note };
}

export function flowRename(src: FlowSource, oldId: string, newId: string, opts?: WriteOpts) {
  const r = resolveSource(src);
  const picked = pickBlock(getBlocks(r), opts?.block);
  if (!picked) {
    return { ok: false, error: 'no Mermaid block found' };
  }
  if (!picked.block.supported) {
    return { ok: false, error: `block ${picked.index} is not a supported flowchart` };
  }
  const result = computeIdRename(picked.block, splitLines(r.text), oldId, newId);
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'rename failed' };
  }
  return finishWrite(r, result, applyEdits(r.text, result.edits), opts);
}

export function flowRelabel(src: FlowSource, id: string, newLabel: string, opts?: WriteOpts) {
  const r = resolveSource(src);
  const picked = pickBlock(getBlocks(r), opts?.block);
  if (!picked) {
    return { ok: false, error: 'no Mermaid block found' };
  }
  if (!picked.block.supported) {
    return { ok: false, error: `block ${picked.index} is not a supported flowchart` };
  }
  // A subgraph TITLE is editable too (the sidebar exposes it, and CLAUDE.md lists it
  // as supported). computeLabelEdit only searches nodes, so dispatch a subgraph id to
  // the subgraph-title editor — otherwise relabelling a subgraph returns a misleading
  // "Node not found".
  const isSubgraph = picked.block.subgraphs.some((s) => s.id === id);
  const result = isSubgraph
    ? computeSubgraphLabelEdit(picked.block, splitLines(r.text), id, newLabel)
    : computeLabelEdit(picked.block, id, newLabel);
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'relabel failed' };
  }
  return finishWrite(r, result, applyEdits(r.text, result.edits), opts);
}
