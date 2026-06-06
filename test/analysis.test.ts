import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMermaidBlocks } from '../src/parser';
import { computeIdRename } from '../src/editor';
import {
  findTagAtPosition,
  findDeclaration,
  findReferences,
  findDuplicateDeclarations,
} from '../src/analysis';

function build(lines: string[]) {
  const text = lines.join('\n');
  return { block: findMermaidBlocks(text, true)[0], lines };
}

const NAV = [
  'graph LR',
  'A --> B[operational flow]',
  'B --> C[done]',
  'subgraph AR1 ["Rules loads"]',
  'RA1[Loads auto] --> RA2[glob]',
  'end',
  'A --> AR1',
];

// --- findTagAtPosition ---

test('findTagAtPosition: on a node definition id → kind node', () => {
  const { block, lines } = build(NAV);
  const ch = lines[1].indexOf('B');
  const hit = findTagAtPosition(block, lines, 1, ch);
  assert.equal(hit?.id, 'B');
  assert.equal(hit?.kind, 'node');
});

test('findTagAtPosition: on a bare edge reference → kind ref', () => {
  const { block, lines } = build(NAV);
  const hit = findTagAtPosition(block, lines, 6, 0); // `A --> AR1`, cursor on A
  assert.equal(hit?.id, 'A');
  assert.equal(hit?.kind, 'ref');
});

test('findTagAtPosition: on a subgraph id → kind subgraph', () => {
  const { block, lines } = build(NAV);
  const ch = lines[3].indexOf('AR1');
  const hit = findTagAtPosition(block, lines, 3, ch);
  assert.equal(hit?.id, 'AR1');
  assert.equal(hit?.kind, 'subgraph');
});

test('findTagAtPosition: inside a label returns undefined', () => {
  const { block, lines } = build(NAV);
  const ch = lines[1].indexOf('operational');
  assert.equal(findTagAtPosition(block, lines, 1, ch), undefined);
});

test('findTagAtPosition: on a keyword returns undefined', () => {
  const { block, lines } = build(NAV);
  assert.equal(findTagAtPosition(block, lines, 0, 2), undefined); // inside "graph"
});

// --- findDeclaration ---

test('findDeclaration: node id → its definition span', () => {
  const { block } = build(NAV);
  const d = findDeclaration(block, 'B');
  assert.equal(d?.kind, 'node');
  assert.equal(d?.line, 1);
  assert.equal(NAV[1].slice(d!.startChar, d!.endChar), 'B');
});

test('findDeclaration: subgraph id → its declaration span', () => {
  const { block } = build(NAV);
  const d = findDeclaration(block, 'AR1');
  assert.equal(d?.kind, 'subgraph');
  assert.equal(d?.line, 3);
  assert.equal(NAV[3].slice(d!.startChar, d!.endChar), 'AR1');
});

test('findDeclaration: an id that only appears as an edge ref has no declaration', () => {
  const { block } = build(NAV);
  assert.equal(findDeclaration(block, 'A'), undefined);
});

// --- findReferences ---

test('findReferences: declaration + all edge references', () => {
  const { block, lines } = build(NAV);
  const refs = findReferences(block, lines, 'AR1');
  assert.deepEqual(refs.map((r) => r.line).sort((a, b) => a - b), [3, 6]);
});

test('findReferences: includeDeclaration=false drops the declaration occurrence', () => {
  const { block, lines } = build(NAV);
  const refs = findReferences(block, lines, 'AR1', false);
  assert.deepEqual(refs.map((r) => r.line), [6]);
});

test('findReferences: never matches a word inside a label', () => {
  const { block, lines } = build(['graph TD', 'A[contains A word] --> B', 'B --> A']);
  const refs = findReferences(block, lines, 'A');
  // A as the line-1 definition id + A as the line-2 target — NOT the "A" inside the label.
  assert.equal(refs.length, 2);
  assert.deepEqual(refs.map((r) => r.line).sort((a, b) => a - b), [1, 2]);
});

// --- findDuplicateDeclarations ---

test('duplicates: same id, two different labels → flagged', () => {
  const { block, lines } = build(['graph TD', 'A[First]', 'A[Second]']);
  const dups = findDuplicateDeclarations(block, lines);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].id, 'A');
  assert.equal(dups[0].reason, 'duplicate-node');
  assert.equal(dups[0].locations.length, 2);
});

test('duplicates: identical re-declaration is NOT flagged', () => {
  const { block, lines } = build(['graph TD', 'A[Same] --> B', 'A[Same]']);
  assert.deepEqual(findDuplicateDeclarations(block, lines), []);
});

test('duplicates: two subgraphs with the same id → flagged', () => {
  const { block, lines } = build(['graph TD', 'subgraph S1 [One]', 'end', 'subgraph S1 [Two]', 'end']);
  const dups = findDuplicateDeclarations(block, lines);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].reason, 'duplicate-subgraph');
  assert.equal(dups[0].id, 'S1');
});

test('duplicates: same id used for a node and a subgraph → flagged', () => {
  const { block, lines } = build(['graph TD', 'X[node]', 'subgraph X [title]', 'end']);
  const dups = findDuplicateDeclarations(block, lines);
  assert.equal(dups.some((d) => d.reason === 'node-and-subgraph' && d.id === 'X'), true);
});

test('duplicates: a tag used as an edge ref AND a subgraph id is NOT flagged', () => {
  // The order-lifecycle case: `A` is an edge endpoint and a subgraph, but never a
  // bracketed node — that is a legal edge-to-subgraph reference, not a collision.
  const { block, lines } = build(['graph LR', 'A --> B[op]', 'subgraph A [checkout]', 'AA1[x]', 'end']);
  assert.deepEqual(findDuplicateDeclarations(block, lines), []);
});

// --- regressions from the adversarial order-lifecycle sweep (all confirmed bugs) ---

// #1 (HIGH): a node named `id` must not match the YAML `id:` frontmatter key —
// otherwise a rename would corrupt the document's frontmatter.
test('sweep#1: findReferences ignores a frontmatter id: key (node named id)', () => {
  const lines = ['---', 'id: example-0001', '---', 'graph LR', 'id[Identity] --> next[Next]'];
  const block = findMermaidBlocks(lines.join('\n'), true)[0];
  assert.equal(block.supported, true);
  assert.deepEqual(findReferences(block, lines, 'id').map((r) => r.line), [4]);
});

// #2 (MED): frontmatter containing bracketed text must not register as a node
// declaration (no false duplicate, and the parsed node keeps its real label).
test('sweep#2: frontmatter is not scanned for node declarations', () => {
  const lines = ['---', 'foo: B[oops]', '---', 'graph LR', 'B[Real] --> C'];
  const block = findMermaidBlocks(lines.join('\n'), true)[0];
  assert.deepEqual(findDuplicateDeclarations(block, lines), []);
  assert.equal(block.nodes.find((n) => n.id === 'B')?.label, 'Real');
});

// #3 (MED): the cursor on a frontmatter line is not a tag.
test('sweep#3: findTagAtPosition is undefined on a frontmatter line', () => {
  const lines = ['---', 'id: example-0001', '---', 'graph LR', 'id[Identity] --> next[Next]'];
  const block = findMermaidBlocks(lines.join('\n'), true)[0];
  assert.equal(findTagAtPosition(block, lines, 1, 0), undefined);
});

// #4 (MED): the `direction TD` keyword must not match a node named TD.
test('sweep#4: findReferences skips the direction keyword (node named TD)', () => {
  const lines = ['graph LR', 'subgraph S["S"]', '  direction TD', '  TD[Top] --> B[b]', 'end'];
  const block = findMermaidBlocks(lines.join('\n'), true)[0];
  assert.deepEqual(findReferences(block, lines, 'TD').map((r) => r.line), [3]);
});

// #5 (MED): the cursor on a `direction TD` keyword is not a tag.
test('sweep#5: findTagAtPosition is undefined on a direction keyword line', () => {
  const lines = ['graph LR', 'subgraph S', '  direction TD', '  TD[Top] --> B[b]', 'end'];
  const block = findMermaidBlocks(lines.join('\n'), true)[0];
  const ch = lines[2].indexOf('TD');
  assert.equal(findTagAtPosition(block, lines, 2, ch), undefined);
});

// #6 (LOW): an id appearing inside an unquoted free-text subgraph title is not a reference.
test('sweep#6: findReferences ignores an id inside an unquoted subgraph title', () => {
  const lines = ['graph TD', 'N[x] --> N2[y]', 'subgraph see N here', 'end', 'N2 --> N'];
  const block = findMermaidBlocks(lines.join('\n'), true)[0];
  assert.deepEqual(findReferences(block, lines, 'N').map((r) => r.line).sort((a, b) => a - b), [1, 4]);
});

// Latent rename-corruption the sweep exposed: computeIdRename must not rewrite a
// `direction TD` keyword line when renaming a node named TD.
test('sweep#4b: computeIdRename does not rewrite a direction keyword line', () => {
  const lines = ['graph LR', 'subgraph S', 'direction TD', 'TD[Top] --> B[b]', 'end'];
  const block = findMermaidBlocks(lines.join('\n'), true)[0];
  const res = computeIdRename(block, lines, 'TD', 'ZZ');
  assert.equal(res.ok, true);
  const editedLines = res.edits.map((e) => e.line);
  assert.ok(!editedLines.includes(2), 'the `direction TD` line must not be edited');
  assert.ok(editedLines.includes(3), 'the TD[Top] node line should be edited');
});
