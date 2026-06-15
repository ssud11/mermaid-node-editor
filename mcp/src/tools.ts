// The six flow tools as PURE functions (no MCP types) so they unit-test directly.
// server.ts wires these to registerTool. All reuse the vscode-free parser/editor/
// analysis layer — no logic is duplicated here.
import { writeFileSync } from 'node:fs';
import type { MermaidBlock } from '../../src/parser';
import { computeIdRename, computeLabelEdit, type EditResult } from '../../src/editor';
import { collectIds, findDeclaration, findDuplicateDeclarations } from '../../src/analysis';
import { resolveSource, getBlocks, pickBlock, type FlowSource, type ResolvedSource } from './resolve';
import { applyEdits } from './apply-edits';
import { shapeOf } from './shapes';

const splitLines = (text: string): string[] => text.split(/\r?\n/);

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
      return {
        index,
        diagramType: b.diagramType,
        supported: b.supported,
        lineRange: [b.startLine, b.endLine] as [number, number],
        counts: { nodes: b.nodes.length, edges: b.edges.length, subgraphs: b.subgraphs.length },
        entryNodes: b.supported ? [...allIds].filter((id) => !tos.has(id)) : [],
        exitNodes: b.supported ? [...allIds].filter((id) => !froms.has(id)) : [],
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
  const r = resolveSource(src);
  const blocks = getBlocks(r);
  const picked = pickBlock(blocks, blockIndex);
  if (!picked) {
    return { id, found: false, error: 'no Mermaid block found' };
  }
  const { block, index } = picked;
  if (!block.supported) {
    return { id, found: false, blockIndex: index, error: `block ${index} is not a supported flowchart` };
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
  const dups = findDuplicateDeclarations(block, lines).filter((d) => d.id === id);
  return {
    id,
    found: known,
    blockIndex: index,
    declaration: decl ? { line: decl.line, kind: decl.kind } : null,
    incoming,
    outgoing,
    subgraph,
    duplicateWarnings: dups.map((d) => ({ reason: d.reason, message: d.message })),
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
    if (b.edges.length > 0) {
      const inEdges = new Set(b.edges.flatMap((e) => [e.from, e.to]));
      const sgIds = new Set(b.subgraphs.map((s) => s.id));
      for (const n of b.nodes) {
        if (!inEdges.has(n.id) && !sgIds.has(n.id)) {
          issues.push({ severity: 'info', code: 'unreachable', message: `node "${n.id}" is declared but not connected by any edge`, line: n.line });
        }
      }
    }
    return { index, supported: true, issues };
  });
  const ok = reports.every((br) => !br.issues.some((i) => i.severity === 'error'));
  return { ok, blocks: reports };
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
  const result = computeLabelEdit(picked.block, id, newLabel);
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'relabel failed' };
  }
  return finishWrite(r, result, applyEdits(r.text, result.edits), opts);
}
