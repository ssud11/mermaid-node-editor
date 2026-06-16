import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMermaidBlocks } from '../src/parser';
import {
  buildNodeRaw,
  computeIdRename,
  computeLabelEdit,
  computeSubgraphLabelEdit,
  needsQuoting,
  renameIdInLine,
} from '../src/editor';

function block(text: string) {
  return { block: findMermaidBlocks(text, true)[0], lines: text.split('\n') };
}

test('needsQuoting: detects syntax-significant chars', () => {
  assert.equal(needsQuoting('plain'), false);
  assert.equal(needsQuoting('has space'), false); // spaces are fine unquoted in mermaid
  assert.equal(needsQuoting('a[b]'), true);
  assert.equal(needsQuoting('pipe|here'), true);
  assert.equal(needsQuoting(''), true);
  assert.equal(needsQuoting(' leading'), true);
});

test('buildNodeRaw: preserves bracket shape, adds quotes only when needed', () => {
  assert.equal(buildNodeRaw({ open: '[', close: ']', quote: '' }, 'A', 'New'), 'A[New]');
  assert.equal(buildNodeRaw({ open: '{', close: '}', quote: '' }, 'A', 'a|b'), 'A{"a|b"}');
  assert.equal(buildNodeRaw({ open: '[', close: ']', quote: '"' }, 'A', 'keep'), 'A["keep"]');
});

// ---- regression: /qa-explore dogfood 2026-06-16 (write-tool source corruption) ----

test('buildNodeRaw: a bare node (no brackets) gains brackets when labelled', () => {
  // bare `Alpha` relabelled to `Gamma` was fusing into `AlphaGamma`.
  assert.equal(buildNodeRaw({ open: '', close: '', quote: '' }, 'Alpha', 'Gamma'), 'Alpha[Gamma]');
});

test('computeIdRename: rejects a reserved-keyword id', () => {
  // rename to `end` (etc.) produced a keyword-led line the parser silently drops.
  const { block: b, lines } = block('graph TD\nA[x] --> B');
  for (const kw of ['end', 'graph', 'subgraph', 'classDef']) {
    const r = computeIdRename(b, lines, 'A', kw);
    assert.equal(r.ok, false, `rename to "${kw}" must be rejected`);
    assert.match(r.error!, /reserved/);
  }
  assert.equal(computeIdRename(b, lines, 'A', 'Start').ok, true); // a non-reserved id still works
});

test('computeLabelEdit: rejects a label containing a line break', () => {
  // an interior newline spliced inside the bracket corrupted the node + its edges.
  const r = computeLabelEdit(block('graph TD\nA[Start]').block, 'A', 'line1\nline2');
  assert.equal(r.ok, false);
  assert.match(r.error!, /line break/);
});

test('computeSubgraphLabelEdit: rejects a title containing a line break', () => {
  // the subgraph-title twin of the node-label newline bug (dogfood follow-up).
  const { block: b, lines } = block('graph TD\nsubgraph S [Phase]\nA[x] --> B\nend');
  const r = computeSubgraphLabelEdit(b, lines, 'S', 'line1\nline2');
  assert.equal(r.ok, false);
  assert.match(r.error!, /line break/);
});

test('computeLabelEdit: labelling a bare node brackets it instead of fusing', () => {
  // `Alpha` is declared bare on its own line, then referenced by an edge. Relabelling
  // the declaration must produce `Alpha[Gamma]` (id intact, edge ref still resolves).
  const r = computeLabelEdit(block('graph TD\nAlpha\nAlpha --> Beta').block, 'Alpha', 'Gamma');
  assert.equal(r.ok, true);
  assert.equal(r.edits[0].newText, 'Alpha[Gamma]');
});

test('computeLabelEdit: replaces just the node label span', () => {
  const { block: b } = block('graph TD\nA[Start] --> B[End]');
  const r = computeLabelEdit(b, 'A', 'Begin');
  assert.equal(r.ok, true);
  assert.equal(r.edits.length, 1);
  assert.equal(r.edits[0].line, 1);
  assert.equal(r.edits[0].newText, 'A[Begin]');
  // span must cover exactly "A[Start]"
  assert.equal(r.edits[0].startChar, 0);
  assert.equal(r.edits[0].endChar, 'A[Start]'.length);
});

test('computeLabelEdit: edits the right node when two share a line', () => {
  const { block: b } = block('graph TD\nA[Start] --> B[End]');
  const r = computeLabelEdit(b, 'B', 'Finish');
  assert.equal(r.edits[0].newText, 'B[Finish]');
  assert.equal(r.edits[0].startChar, 'A[Start] --> '.length);
});

test('renameIdInLine: renames references but not text inside labels', () => {
  assert.equal(renameIdInLine('A[A is here] --> B', 'A', 'Z'), 'Z[A is here] --> B');
  assert.equal(renameIdInLine('B --> A', 'A', 'Z'), 'B --> Z');
  assert.equal(renameIdInLine('A -->|A label| C', 'A', 'Z'), 'Z -->|A label| C');
});

test('renameIdInLine: whole-word only (does not touch A10 when renaming A)', () => {
  assert.equal(renameIdInLine('A --> A10', 'A', 'Z'), 'Z --> A10');
});

test('computeIdRename: propagates across the whole block', () => {
  const text = ['graph TD', 'A[Start] --> B[Mid]', 'B --> A', 'C --> A'].join('\n');
  const { block: b, lines } = block(text);
  const r = computeIdRename(b, lines, 'A', 'Start');
  assert.equal(r.ok, true);
  // Apply the edits to verify the end result.
  const out = [...lines];
  for (const e of r.edits) out[e.line] = e.newText;
  assert.deepEqual(out, ['graph TD', 'Start[Start] --> B[Mid]', 'B --> Start', 'C --> Start']);
});

test('computeIdRename: rejects collision with an existing id', () => {
  const { block: b, lines } = block('graph TD\nA[X] --> B[Y]');
  const r = computeIdRename(b, lines, 'A', 'B');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /already exists/);
});

test('computeIdRename: rejects an invalid id', () => {
  const { block: b, lines } = block('graph TD\nA[X] --> B[Y]');
  const r = computeIdRename(b, lines, 'A', 'has space');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /Invalid id/);
});

test('computeSubgraphLabelEdit: keeps the id, rewrites the title', () => {
  const text = ['flowchart LR', 'subgraph grp [Old Title]', 'A[x]', 'end'].join('\n');
  const { block: b, lines } = block(text);
  const r = computeSubgraphLabelEdit(b, lines, 'grp', 'New Title');
  assert.equal(r.ok, true);
  assert.equal(r.edits[0].newText, 'subgraph grp [New Title]');
});

test('computeSubgraphLabelEdit: adds a bracket when the subgraph had only an id', () => {
  const text = ['flowchart LR', 'subgraph grp', 'A[x]', 'end'].join('\n');
  const { block: b, lines } = block(text);
  const r = computeSubgraphLabelEdit(b, lines, 'grp', 'A Title');
  assert.equal(r.edits[0].newText, 'subgraph grp [A Title]');
});

// --- IT-6 regression tests: edge-case rename bugs found in code review ---

test('computeIdRename: rejects renaming onto a bare referenced id (no silent merge)', () => {
  // X is referenced in edges but never bracket-defined; renaming A->X would
  // collapse A and X into one node.
  const { block: b, lines } = block('graph TD\nA[Start] --> X\nB --> X');
  const r = computeIdRename(b, lines, 'A', 'X');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /already exists/);
});

test('computeIdRename: does not rewrite the graph directive (node named TD)', () => {
  const { block: b, lines } = block('graph TD\nTD[Top] --> B');
  const r = computeIdRename(b, lines, 'TD', 'Z');
  assert.equal(r.ok, true);
  const out = [...lines];
  for (const e of r.edits) out[e.line] = e.newText;
  assert.equal(out[0], 'graph TD'); // directive untouched
  assert.equal(out[1], 'Z[Top] --> B');
});

test('computeIdRename: does not rewrite text inside a subgraph title', () => {
  const text = ['flowchart LR', 'subgraph S1 [About A]', 'A[x] --> B[y]', 'end'].join('\n');
  const { block: b, lines } = block(text);
  const r = computeIdRename(b, lines, 'A', 'Z');
  assert.equal(r.ok, true);
  const out = [...lines];
  for (const e of r.edits) out[e.line] = e.newText;
  assert.equal(out[1], 'subgraph S1 [About A]'); // title text untouched
  assert.equal(out[2], 'Z[x] --> B[y]'); // body node renamed
});

test('computeIdRename: does not rewrite the o/x letter inside --o / --x arrowheads', () => {
  const { block: b, lines } = block('graph TD\nA[Start] --o o[Circle]');
  const r = computeIdRename(b, lines, 'o', 'Z');
  assert.equal(r.ok, true);
  const out = [...lines];
  for (const e of r.edits) out[e.line] = e.newText;
  assert.equal(out[1], 'A[Start] --o Z[Circle]'); // arrowhead --o intact, node o renamed
});

// --- regression: id rename must not corrupt inline
// edge-LABEL prose (dash / thick / dotted forms). Pipe-form was already safe. ---

test('renameIdInLine: does not rewrite an id-word inside a dash-delimited edge label', () => {
  // `send A data` is label prose, not a reference — renaming node A must leave it.
  assert.equal(
    renameIdInLine('A -- send A data --> B', 'A', 'X'),
    'X -- send A data --> B'
  );
});

test('renameIdInLine: protects inline labels in dotted and thick edge forms', () => {
  assert.equal(renameIdInLine('A -. start tip .-> B', 'start', 'S'), 'A -. start tip .-> B');
  assert.equal(renameIdInLine('A == start now ==> B', 'start', 'S'), 'A == start now ==> B');
  assert.equal(renameIdInLine('A --- keep A here --- B', 'A', 'X'), 'X --- keep A here --- B');
});

test('renameIdInLine: still rewrites real endpoint ids around an inline label', () => {
  // The label prose is protected, but the from/to node ids around it are not.
  assert.equal(renameIdInLine('A -- to A --> A', 'A', 'X'), 'X -- to A --> X');
});

test('computeIdRename: collision guard sees a bare ref even with a trailing semicolon', () => {
  // Before the `;`-statement parse fix, the edge `A --> B;` was dropped, so B was
  // invisible to the collision guard and renaming X->B silently merged two nodes.
  const { block: b, lines } = block('graph TD\nA[Start] --> B;\nX[Other]');
  const r = computeIdRename(b, lines, 'X', 'B');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /already exists/);
});
