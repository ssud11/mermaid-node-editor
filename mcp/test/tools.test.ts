import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  flowOverview,
  flowExtract,
  flowQuery,
  flowValidate,
  flowRename,
  flowRelabel,
} from '../src/tools';
import { applyEdits } from '../src/apply-edits';
import { resolveSource } from '../src/resolve';

// A,B,C on the main spine; D is first-seen INSIDE subgraph S (so it's a member).
const FLOW = ['graph TD', 'A[Start] -->|yes| B{Check}', 'B -.-> C(Stop)', 'subgraph S [Phase]', 'D[Inside]', 'end'].join('\n');

// ---- resolve ----
test('resolveSource: inline raw diagram is .mmd; fenced is markdown; path by extension', () => {
  assert.equal(resolveSource({ text: 'graph TD\nA-->B' }).isMmd, true);
  assert.equal(resolveSource({ text: '```mermaid\ngraph TD\nA-->B\n```' }).isMmd, false);
  assert.throws(() => resolveSource({}), /text.*or.*path/);
});

// ---- applyEdits ----
test('applyEdits: right-to-left, preserves the rest of the line', () => {
  assert.equal(applyEdits('A --> B', [{ line: 0, startChar: 0, endChar: 1, newText: 'XX' }]), 'XX --> B');
  // two edits on one line apply without offset corruption
  assert.equal(
    applyEdits('A --> A', [
      { line: 0, startChar: 0, endChar: 1, newText: 'Z' },
      { line: 0, startChar: 6, endChar: 7, newText: 'Z' },
    ]),
    'Z --> Z'
  );
});

// ---- flow_extract ----
test('flow_extract: typed nodes (shape) + edges (label,kind) + subgraph members', () => {
  const { blocks } = flowExtract({ text: FLOW });
  const b = blocks[0];
  assert.equal(b.supported, true);
  assert.deepEqual(
    b.nodes.find((n) => n.id === 'A'),
    { id: 'A', label: 'Start', shape: 'rectangle', line: 1 }
  );
  assert.equal(b.nodes.find((n) => n.id === 'B')!.shape, 'diamond');
  assert.equal(b.nodes.find((n) => n.id === 'C')!.shape, 'rounded');
  const e0 = b.edges[0];
  assert.deepEqual([e0.from, e0.to, e0.label, e0.kind.stroke], ['A', 'B', 'yes', 'solid']);
  assert.equal(b.edges[1].kind.stroke, 'dotted');
  assert.deepEqual(b.subgraphs[0], { id: 'S', title: 'Phase', members: ['D'] });
});

test('flow_extract: unsupported diagram → supported:false, no crash', () => {
  const { blocks } = flowExtract({ text: 'sequenceDiagram\nAlice->>Bob: hi' });
  assert.equal(blocks[0].supported, false);
});

// ---- flow_overview ----
test('flow_overview: counts + entry/exit nodes + subgraph tree', () => {
  const o = flowOverview({ text: FLOW });
  const b = o.blocks[0];
  assert.deepEqual(b.counts, { nodes: 4, edges: 2, subgraphs: 1 });
  assert.ok(b.entryNodes.includes('A')); // A is a pure source
  assert.ok(b.exitNodes.includes('C')); // C is a pure sink
  assert.deepEqual(b.subgraphs[0], { id: 'S', title: 'Phase', members: ['D'] });
});

// ---- flow_query ----
test('flow_query: neighborhood with edge labels + subgraph membership', () => {
  const q = flowQuery({ text: FLOW }, 'B');
  assert.equal(q.found, true);
  assert.deepEqual(q.incoming, [{ from: 'A', label: 'yes', kind: { stroke: 'solid', head: 'arrow', bidirectional: false }, line: 1 }]);
  assert.equal(q.outgoing!.length, 1);
  assert.equal(q.outgoing![0].to, 'C');
  const qd = flowQuery({ text: FLOW }, 'D');
  assert.equal(qd.subgraph, 'S'); // D is first-seen inside S
});

test('flow_query: duplicate-tag warning surfaces', () => {
  const q = flowQuery({ text: 'graph TD\nX[one]\nX[two]' }, 'X');
  assert.ok(q.duplicateWarnings!.length >= 1);
});

// ---- flow_validate ----
test('flow_validate: duplicate + empty-label + unsupported', () => {
  assert.equal(flowValidate({ text: 'graph TD\nX[a]\nX[b]' }).blocks[0].issues.some((i) => i.code === 'duplicate-node'), true);
  assert.equal(flowValidate({ text: 'graph TD\nA[""] --> B[ok]' }).blocks[0].issues.some((i) => i.code === 'empty-label'), true);
  assert.equal(flowValidate({ text: 'sequenceDiagram\nA->>B: x' }).blocks[0].issues[0].code, 'unsupported');
  assert.equal(flowValidate({ text: 'not a diagram at all' }).ok !== undefined, true);
});

// ---- flow_rename ----
test('flow_rename: propagates to edges, returns edited text, no write by default', () => {
  const r = flowRename({ text: 'graph TD\nA[x] --> B\nB --> A' }, 'A', 'Z') as { ok: boolean; newText: string; written: boolean; changed: boolean };
  assert.equal(r.ok, true);
  assert.equal(r.written, false);
  assert.match(r.newText, /Z\[x\] --> B/);
  assert.match(r.newText, /B --> Z/); // edge reference propagated
});

test('flow_rename: write:true on a path writes the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-'));
  const p = join(dir, 'd.mmd');
  writeFileSync(p, 'graph TD\nA[x] --> B', 'utf8');
  const r = flowRename({ path: p }, 'A', 'Z', { write: true }) as { ok: boolean; written: boolean };
  assert.equal(r.written, true);
  assert.match(readFileSync(p, 'utf8'), /Z\[x\] --> B/);
});

test('flow_rename: write:true on inline text is a no-op write (returns text + note)', () => {
  const r = flowRename({ text: 'graph TD\nA --> B' }, 'A', 'Z', { write: true }) as { written: boolean; note?: string };
  assert.equal(r.written, false);
  assert.match(r.note ?? '', /no .*path/);
});

// ---- flow_relabel ----
test('flow_relabel: changes label, preserves shape, auto-quotes when needed', () => {
  const r = flowRelabel({ text: 'graph TD\nA[Start]' }, 'A', 'New Label') as { ok: boolean; newText: string };
  assert.equal(r.ok, true);
  assert.match(r.newText, /A\[New Label\]/);
});
