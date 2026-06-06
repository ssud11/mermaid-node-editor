import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMermaidBlocks } from '../src/parser';
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
