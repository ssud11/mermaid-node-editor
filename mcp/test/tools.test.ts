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

test("flow_query: returns the queried node's own label", () => {
  assert.equal((flowQuery({ text: FLOW }, 'B') as { label: string | null }).label, 'Check');
  assert.equal((flowQuery({ text: FLOW }, 'A') as { label: string | null }).label, 'Start');
  assert.equal((flowQuery({ text: FLOW }, 'D') as { label: string | null }).label, 'Inside');
  // an unknown id has no own label
  assert.equal((flowQuery({ text: FLOW }, 'ZZZ') as { label: string | null }).label, null);
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

// ---- regression: edge-case findings (subgraph topology, validate gating, mixed EOL) ----

// A subgraph container id is a grouping, not a flow node — it must not be reported
// as an entry OR exit node (it would otherwise appear in BOTH, since it's never an
// edge endpoint).
test('flow_overview: subgraph container id is not an entry or exit node', () => {
  const o = flowOverview({ text: 'graph TD\nsubgraph PROC [Processing]\nX --> Y\nend' });
  const b = o.blocks[0];
  assert.ok(!b.entryNodes.includes('PROC'));
  assert.ok(!b.exitNodes.includes('PROC'));
  assert.deepEqual(b.entryNodes, ['X']);
  assert.deepEqual(b.exitNodes, ['Y']);
});

// A node declared inside a subgraph is intentionally grouped, not orphaned — it
// must not false-positive as unreachable. A genuine top-level orphan still does.
test('flow_validate: a subgraph member is not flagged unreachable, but a real orphan is', () => {
  const v = flowValidate({ text: 'graph TD\nsubgraph CHECKOUT [Checkout]\npayment[Pay]\nend\nA --> B' });
  assert.equal(v.blocks[0].issues.some((i) => i.code === 'unreachable' && i.message.includes('payment')), false);
  const v2 = flowValidate({ text: 'graph TD\nA --> B\nORPHAN[x]' });
  assert.equal(v2.blocks[0].issues.some((i) => i.code === 'unreachable' && i.message.includes('ORPHAN')), true);
});

// `ok` must not green-light a file with no processable flowchart.
test('flow_validate: ok is false when every block is an unsupported diagram type', () => {
  const v = flowValidate({ text: 'sequenceDiagram\nAlice->>Bob: hi' });
  assert.equal(v.ok, false);
  assert.equal(v.blocks[0].supported, false);
});

// …but ok stays true when at least one block is a clean, supported flowchart.
test('flow_validate: ok stays true when a supported flowchart is present alongside an unsupported block', () => {
  const md = '```mermaid\ngraph TD\nA --> B\n```\n\n```mermaid\nsequenceDiagram\nA->>B: x\n```';
  assert.equal(flowValidate({ text: md }).ok, true);
});

// A mixed-EOL file must keep each line's original terminator — only the edited
// span changes (no silent CRLF/LF normalization on untouched lines).
test('applyEdits: preserves each line\'s original EOL on a mixed-ending file', () => {
  const input = 'graph TD\r\nA[hello] --> B\nB[world]\r\n';
  const out = applyEdits(input, [{ line: 1, startChar: 0, endChar: 1, newText: 'X' }]);
  assert.equal(out, 'graph TD\r\nX[hello] --> B\nB[world]\r\n');
});

// ---- regression: /qa-explore dogfood round 2 (2026-06-16) ----

// flow_relabel on a SUBGRAPH id must retitle it (dispatch to computeSubgraphLabelEdit),
// not return a misleading "Node not found" — subgraph titles are a supported edit.
test('flow_relabel: retitles a subgraph when the id is a subgraph (not "node not found")', () => {
  const r = flowRelabel({ text: 'graph TD\nsubgraph S [Phase]\nA[x] --> B[y]\nend' }, 'S', 'New Phase') as { ok: boolean; newText: string };
  assert.equal(r.ok, true);
  assert.match(r.newText, /subgraph S \[New Phase\]/);
  assert.match(r.newText, /A\[x\] --> B\[y\]/); // body untouched
});

// The literal ```mermaid string INSIDE a node label must NOT flip a raw flowchart
// into markdown mode (which yielded zero blocks). A real leading fence still does.
test('resolveSource: a fence string inside a label stays raw .mmd; a real leading fence is markdown', () => {
  const inLabel = 'graph TD\n' + 'A["see ' + '```' + 'mermaid"] --> B';
  assert.equal(resolveSource({ text: inLabel }).isMmd, true);
  assert.equal(flowValidate({ text: inLabel }).blocks.length, 1); // parses as one flowchart, not zero blocks
  const realFence = '# doc\n\n' + '```' + 'mermaid\ngraph TD\nA --> B\n' + '```';
  assert.equal(resolveSource({ text: realFence }).isMmd, false);
});

// flow_validate returns a consistent {ok, issues, blocks} shape across all branches:
// file-level problems in top-level `issues`, per-block problems in `blocks[].issues`.
test('flow_validate: always returns a top-level issues array (consistent shape)', () => {
  const good = flowValidate({ text: 'graph TD\nA[x] --> B[y]' });
  assert.ok(Array.isArray(good.issues) && Array.isArray(good.blocks));
  const unsupported = flowValidate({ text: 'sequenceDiagram\nA->>B: x' });
  assert.ok(Array.isArray(unsupported.issues) && Array.isArray(unsupported.blocks));
});

// ---- regression: /qa-explore dogfood round 3 (2026-06-16) ----

// `A --> B & C` fan-out is not parsed in v1; validate must WARN (not silently pass)
// so an agent never gets a false-clean for a flow whose edges all vanished.
test('flow_validate: warns on & fan-out edges instead of a silent false-clean', () => {
  const v = flowValidate({ text: 'flowchart TD\nstart[Start]\na[A]\nb[B]\nstart --> a & b' });
  assert.ok(v.blocks[0].issues.some((i) => i.code === 'unsupported-fanout'));
});

// A `&` INSIDE a label is ordinary text, not fan-out — must not false-trigger.
test('flow_validate: a & inside a label is not flagged as fan-out', () => {
  const v = flowValidate({ text: 'flowchart TD\nA["x & y"] --> B[ok]' });
  assert.equal(v.blocks[0].issues.some((i) => i.code === 'unsupported-fanout'), false);
});

// flow_query's error paths must return EXACTLY the same key set as the normal path
// (in BOTH directions — including `error`, present everywhere), so a flow-follow agent
// reading .outgoing / .label / .error never hits an undefined on any branch.
test('flow_query: every path returns an identical key set (both directions)', () => {
  const keys = (o: object) => Object.keys(o).sort().join(',');
  const found = flowQuery({ text: 'graph TD\nA[x] --> B[y]' }, 'A'); // normal, found
  const notFound = flowQuery({ text: 'graph TD\nA[x] --> B[y]' }, 'ZZZ'); // normal, id absent
  const noBlock = flowQuery({ text: 'graph TD\nA[x] --> B[y]' }, 'A', 99); // out-of-range block
  const unsupported = flowQuery({ text: 'sequenceDiagram\nA->>B: x' }, 'A'); // unsupported block
  const ref = keys(found);
  assert.equal(keys(notFound), ref, 'id-not-found shape diverges');
  assert.equal(keys(noBlock), ref, 'no-block shape diverges');
  assert.equal(keys(unsupported), ref, 'unsupported shape diverges');
  assert.equal(found.error, null); // present + null on the success path
  assert.equal(notFound.error, null);
  assert.deepEqual(noBlock.outgoing, []); // not undefined
});

// flow_relabel on a bare edge-ref id (which flow_query reports found:true) must give
// an actionable "add a shape first" message, not a contradictory "node not found".
test('flow_relabel: a bare edge-ref id gets an actionable message, not "not found"', () => {
  const r = flowRelabel({ text: 'graph TD\nA[x] --> B' }, 'B', 'New') as { ok: boolean; error: string };
  assert.equal(r.ok, false);
  assert.match(r.error, /referenced by edges|give it a shape/i);
});

// ---- regression: /qa-explore dogfood round 5 (2026-06-16) ----
// Three silent-drop classes: the parser skips the line, the node/edge vanishes, and
// validate would stay ok:true. Each must now surface a warning (false-clean removed).

test('flow_validate: warns on a hyphenated id (truncated + edge dropped)', () => {
  const v = flowValidate({ text: 'graph TD\nreceive-order[Receive order] --> in-stock{In stock?}' });
  assert.ok(v.blocks[0].issues.some((i) => i.code === 'malformed-id'));
});

test('flow_validate: a hyphen INSIDE a label is not flagged as a malformed id', () => {
  const v = flowValidate({ text: 'graph TD\nA[multi-word label] --> B[ok]' });
  assert.equal(v.blocks[0].issues.some((i) => i.code === 'malformed-id'), false);
});

test('flow_validate: warns on a reserved-keyword id used on an edge line', () => {
  const v = flowValidate({ text: 'flowchart TD\nA[Start] --> end\nend --> B[Finish]' });
  assert.ok(v.blocks[0].issues.some((i) => i.code === 'reserved-id-edge'));
});

test('flow_validate: warns on a multi-line (unclosed-quote) label', () => {
  const v = flowValidate({ text: 'flowchart TD\nA["first line\nsecond line"] --> B[Done]' });
  assert.ok(v.blocks[0].issues.some((i) => i.code === 'multiline-label'));
});

// flow_query on a subgraph id must report its title, not label:null (matches
// flow_extract / flow_overview, which expose the subgraph title correctly).
test('flow_query: a subgraph id reports its title, not null', () => {
  const q = flowQuery({ text: 'flowchart TD\nsubgraph core [Core flow]\nA[x]\nend' }, 'core');
  assert.equal(q.found, true);
  assert.equal(q.label, 'Core flow');
});

// ---- regression: /qa-explore dogfood round 6 (2026-06-16) ----
// A stray closing bracket inside an unquoted label closes the node early and drops
// the edge — structuralPart() blanks brackets, so this probe runs on the raw line.
test('flow_validate: warns on an unmatched closing bracket (premature node close)', () => {
  const v = flowValidate({ text: 'graph TD\nA[lab]el] --> B[ok]' });
  assert.ok(v.blocks[0].issues.some((i) => i.code === 'unbalanced-bracket'));
});

test('flow_validate: a balanced nested-quote label is not flagged unbalanced', () => {
  const v = flowValidate({ text: 'graph TD\nA["a]b"] --> B[ok]' });
  assert.equal(v.blocks[0].issues.some((i) => i.code === 'unbalanced-bracket'), false);
});

// ---- regression: /qa-explore dogfood round 7 (2026-06-16) ----

// A reserved keyword used as a standalone node declaration (`end[End node]`, edge on a
// separate line) is dropped by the parser — the edge-form probe misses it, so a
// dedicated declaration probe must fire.
test('flow_validate: warns on a reserved-keyword standalone declaration', () => {
  const v = flowValidate({ text: 'flowchart TD\nstart[Start]\nend[End node]\nstart --> end' });
  assert.ok(v.blocks[0].issues.some((i) => i.code === 'reserved-id-dropped'));
});

// A subgraph header (`subgraph S [Title]`) must NOT be mistaken for a dropped reserved id.
test('flow_validate: a subgraph header is not flagged reserved-id-dropped', () => {
  const v = flowValidate({ text: 'flowchart TD\nsubgraph S [Phase]\nA[x]\nend' });
  assert.equal(v.blocks[0].issues.some((i) => i.code === 'reserved-id-dropped'), false);
});

// An out-of-range blockIndex reports the count, not the generic "no Mermaid block found".
test('flow_query: an out-of-range blockIndex reports the block count', () => {
  const md = '```mermaid\ngraph TD\nA-->B\n```\n\n```mermaid\ngraph LR\nC-->D\n```';
  const q = flowQuery({ text: md }, 'A', 9);
  assert.equal(q.found, false);
  assert.match(q.error ?? '', /out of range/i);
});

// ---- regression: /qa-explore dogfood round 8 (2026-06-16) ----
// A missing positional id (an untyped caller merged it into the src object) must give
// a diagnostic error, not a silent found:false with error:null.
test('flow_query: a missing positional id yields a diagnostic', () => {
  const q = flowQuery({ text: 'graph TD\nA[x] --> B[y]' }, undefined as unknown as string);
  assert.equal(q.found, false);
  assert.match(q.error ?? '', /No node id provided/);
});
