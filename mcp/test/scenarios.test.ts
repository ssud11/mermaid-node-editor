// P2 (agent/MCP consumer) multi-turn acceptance scenarios (QA-3).
//
// Exercises realistic agent CONSUMPTION LOOPS over the pure tool functions —
// orient → extract → query → edit → re-validate, chaining each tool's output
// into the next (as an agent would). Fixtures are NEUTRAL synthesized flows
// modelled on the internal consumer's corpus shape (small-to-medium per-stage
// pipelines, YAML-frontmatter configs, mixed supported/unsupported blocks) —
// no consumer content is reproduced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowOverview, flowExtract, flowQuery, flowValidate, flowRename, flowRelabel } from '../src/tools';

// A per-stage pipeline with a branch — the common shape an agent walks + edits.
const PIPELINE = [
  'graph TD',
  '  intake[Receive order] --> check{In stock?}',
  '  check -->|yes| pack[Pack items]',
  '  check -->|no| backorder[Backorder]',
  '  pack --> ship[Ship]',
  '  backorder --> notify[Notify customer]',
  '  ship --> done[Complete]',
].join('\n');

test('scenario: agent loop — orient → extract → query → rename → re-validate', () => {
  // 1. orient
  const o = flowOverview({ text: PIPELINE });
  assert.equal(o.blocks[0].supported, true);
  assert.deepEqual(o.blocks[0].counts, { nodes: 7, edges: 6, subgraphs: 0 });
  assert.ok(o.blocks[0].entryNodes.includes('intake')); // pure source
  assert.ok(o.blocks[0].exitNodes.includes('done')); // pure sink

  // 2. extract typed structure
  const x = flowExtract({ text: PIPELINE }).blocks[0];
  assert.equal(x.nodes.find((n) => n.id === 'check')!.shape, 'diamond');

  // 3. query the branch point
  const q = flowQuery({ text: PIPELINE }, 'check');
  assert.equal(q.found, true);
  assert.deepEqual(q.outgoing!.map((e) => [e.to, e.label]).sort(), [['backorder', 'no'], ['pack', 'yes']]);

  // 4. rename the branch node — propagates to every edge ref
  const r = flowRename({ text: PIPELINE }, 'check', 'stockCheck') as { ok: boolean; newText: string };
  assert.equal(r.ok, true);
  assert.match(r.newText, /intake\[Receive order\] --> stockCheck\{In stock\?\}/);
  assert.match(r.newText, /stockCheck -->\|yes\| pack/);
  assert.match(r.newText, /stockCheck -->\|no\| backorder/);

  // 5. re-validate the EDITED text — still a clean, fully-connected flow
  const v = flowValidate({ text: r.newText });
  assert.equal(v.ok, true);
  assert.equal(v.blocks[0].issues.length, 0);

  // 6. the renamed node is now queryable; the old id is gone
  assert.equal(flowQuery({ text: r.newText }, 'stockCheck').found, true);
  assert.equal(flowQuery({ text: r.newText }, 'check').found, false);
});

test('scenario: YAML-frontmatter config flow — tools operate past the config block', () => {
  const FM = ['---', 'config:', '  layout: elk', '---', 'flowchart TD', '  a[Author] --> b[Review]', '  b --> c[Publish]'].join('\n');
  const o = flowOverview({ text: FM });
  assert.equal(o.format, 'mmd');
  assert.equal(o.blocks[0].supported, true);
  assert.deepEqual(o.blocks[0].counts, { nodes: 3, edges: 2, subgraphs: 0 });

  const r = flowRename({ text: FM }, 'b', 'approve') as { ok: boolean; newText: string };
  assert.equal(r.ok, true);
  assert.match(r.newText, /^---\nconfig:\n {2}layout: elk\n---/); // frontmatter untouched
  assert.match(r.newText, /a\[Author\] --> approve/);
  assert.match(r.newText, /approve --> c/);
  assert.equal(flowValidate({ text: r.newText }).ok, true);
});

test('scenario: mixed markdown — agent targets the flowchart, sees the other block as unsupported', () => {
  const MD = [
    '# Pipeline doc',
    '```mermaid',
    'graph TD',
    'X[Open] --> Y[Close]',
    '```',
    'prose between blocks',
    '```mermaid',
    'sequenceDiagram',
    'Alice->>Bob: hi',
    '```',
  ].join('\n');
  const o = flowOverview({ text: MD });
  assert.equal(o.format, 'markdown');
  assert.equal(o.blockCount, 2);
  assert.equal(o.blocks[0].supported, true);
  assert.equal(o.blocks[1].supported, false);

  // extracting the unsupported block is graceful
  assert.equal(flowExtract({ text: MD }, 1).blocks[0].supported, false);

  // a rename with no explicit block targets the first SUPPORTED block (the flowchart)
  const r = flowRename({ text: MD }, 'X', 'Start') as { ok: boolean; newText: string };
  assert.equal(r.ok, true);
  assert.match(r.newText, /Start\[Open\] --> Y/);
  assert.match(r.newText, /sequenceDiagram/); // the other block is untouched
});

test('scenario: relabel then validate — label change keeps the flow valid + topology intact', () => {
  const before = flowExtract({ text: PIPELINE }).blocks[0].edges.map((e) => `${e.from}->${e.to}`).sort();
  const r = flowRelabel({ text: PIPELINE }, 'pack', 'Pack and weigh') as { ok: boolean; newText: string };
  assert.equal(r.ok, true);
  assert.match(r.newText, /pack\[Pack and weigh\]/); // shape preserved, no quoting needed
  const after = flowExtract({ text: r.newText }).blocks[0].edges.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(after, before); // relabel never changes edges
  assert.equal(flowValidate({ text: r.newText }).ok, true);
});
