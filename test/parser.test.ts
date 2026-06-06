import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMermaidBlocks, scanNodes } from '../src/parser';

test('scanNodes: basic rectangle node', () => {
  const nodes = scanNodes('A[Start]', 0);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, 'A');
  assert.equal(nodes[0].label, 'Start');
  assert.equal(nodes[0].open, '[');
  assert.equal(nodes[0].close, ']');
  assert.equal(nodes[0].raw, 'A[Start]');
});

test('scanNodes: quoted label with spaces', () => {
  const nodes = scanNodes('A["label with spaces"]', 0);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, 'label with spaces');
  assert.equal(nodes[0].quote, '"');
});

test('scanNodes: multiple shapes', () => {
  const nodes = scanNodes('A(Round) --> B{Decision} --> C((Circle))', 0);
  assert.deepEqual(
    nodes.map((n) => [n.id, n.label, n.open, n.close]),
    [
      ['A', 'Round', '(', ')'],
      ['B', 'Decision', '{', '}'],
      ['C', 'Circle', '((', '))'],
    ]
  );
});

test('scanNodes: inline edge node definitions on one line', () => {
  const nodes = scanNodes('A[Start] --> B[End]', 5);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].id, 'A');
  assert.equal(nodes[1].id, 'B');
  assert.equal(nodes[1].line, 5);
});

test('scanNodes: does not match an id that is part of a longer id', () => {
  // "xA[..]" — the leading x makes "xA" the identifier; we only define from a boundary.
  const nodes = scanNodes('foo bar', 0);
  assert.equal(nodes.length, 0);
});

test('findBlocks (.mmd): whole file is one flowchart block', () => {
  const text = ['graph TD', '  A[Start] --> B[End]', '  B --> C{Done?}'].join('\n');
  const blocks = findMermaidBlocks(text, true);
  assert.equal(blocks.length, 1);
  const b = blocks[0];
  assert.equal(b.supported, true);
  assert.equal(b.diagramType, 'graph TD');
  assert.deepEqual(b.nodes.map((n) => n.id).sort(), ['A', 'B', 'C']);
  assert.deepEqual(
    b.edges.map((e) => `${e.from}->${e.to}`),
    ['A->B', 'B->C']
  );
});

test('findBlocks: node inside a subgraph', () => {
  const text = [
    'flowchart LR',
    '  subgraph grp [My Group]',
    '    A[Inside]',
    '  end',
    '  A --> B[Outside]',
  ].join('\n');
  const b = findMermaidBlocks(text, true)[0];
  assert.equal(b.subgraphs.length, 1);
  assert.equal(b.subgraphs[0].id, 'grp');
  assert.equal(b.subgraphs[0].label, 'My Group');
  assert.equal(b.subgraphs[0].hasId, true);
  assert.deepEqual(b.nodes.map((n) => n.id).sort(), ['A', 'B']);
});

test('findBlocks: subgraph with quoted title and no id', () => {
  const b = findMermaidBlocks(['graph TD', 'subgraph "Big Title"', 'A[x]', 'end'].join('\n'), true)[0];
  assert.equal(b.subgraphs[0].label, 'Big Title');
  assert.equal(b.subgraphs[0].hasId, false);
});

test('findBlocks (markdown): two mermaid blocks in one document', () => {
  const text = [
    '# Notes',
    '',
    '```mermaid',
    'graph TD',
    'A[One] --> B[Two]',
    '```',
    '',
    'Some prose.',
    '',
    '```mermaid',
    'flowchart LR',
    'X[Three] --> Y[Four]',
    '```',
  ].join('\n');
  const blocks = findMermaidBlocks(text, false);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].nodes.map((n) => n.id), ['A', 'B']);
  assert.deepEqual(blocks[1].nodes.map((n) => n.id), ['X', 'Y']);
  // Second block's lines should be offset correctly for write-back.
  assert.equal(blocks[1].nodes[0].line, 11);
});

test('findBlocks: non-flowchart diagram is marked unsupported', () => {
  const b = findMermaidBlocks(['sequenceDiagram', 'Alice->>Bob: Hi'].join('\n'), true)[0];
  assert.equal(b.supported, false);
  assert.equal(b.nodes.length, 0);
});

test('findBlocks: comments are ignored', () => {
  const b = findMermaidBlocks(['graph TD', '%% this is a comment A[ghost]', 'A[Real]'].join('\n'), true)[0];
  assert.deepEqual(b.nodes.map((n) => n.id), ['A']);
  assert.equal(b.nodes[0].label, 'Real');
});

// --- 2026-06-06 deep-review regression: YAML frontmatter (title:/config:) before
// the diagram keyword must not mark a valid flowchart unsupported. ---

test('findBlocks (.mmd): YAML title frontmatter before the flowchart is supported', () => {
  const text = ['---', 'title: My Flow', '---', 'flowchart LR', 'A[Start] --> B[End]'].join('\n');
  const b = findMermaidBlocks(text, true)[0];
  assert.equal(b.supported, true);
  assert.equal(b.diagramType, 'flowchart LR');
  assert.deepEqual(b.nodes.map((n) => n.id).sort(), ['A', 'B']);
});

test('findBlocks (.mmd): multi-line config frontmatter is skipped', () => {
  const text = ['---', 'config:', '  theme: dark', '  look: handDrawn', '---', 'graph TD', 'A --> B'].join('\n');
  const b = findMermaidBlocks(text, true)[0];
  assert.equal(b.supported, true);
  assert.deepEqual(
    b.edges.map((e) => `${e.from}->${e.to}`),
    ['A->B']
  );
});

test('findBlocks (markdown): frontmatter inside a mermaid fence is supported', () => {
  const text = ['```mermaid', '---', 'title: X', '---', 'flowchart TD', 'A[a] --> B[b]', '```'].join('\n');
  const b = findMermaidBlocks(text, false)[0];
  assert.equal(b.supported, true);
  assert.deepEqual(b.nodes.map((n) => n.id).sort(), ['A', 'B']);
});

test('findBlocks: an unterminated frontmatter fence stays unsupported (no runaway)', () => {
  const b = findMermaidBlocks(['---', 'title: X', 'flowchart LR', 'A --> B'].join('\n'), true)[0];
  assert.equal(b.supported, false);
});

// --- 2026-06-06 deep-review regression: `;` statement terminators must not drop
// real edges or synthesize spurious ones. ---

test('parseEdges: a trailing semicolon does not drop the edge', () => {
  const b = findMermaidBlocks(['graph TD', 'A --> B;'].join('\n'), true)[0];
  assert.deepEqual(
    b.edges.map((e) => `${e.from}->${e.to}`),
    ['A->B']
  );
});

test('parseEdges: two statements on one line parse separately (no spurious cross-edge)', () => {
  const b = findMermaidBlocks(['graph TD', 'A --> B; C --> D'].join('\n'), true)[0];
  assert.deepEqual(
    b.edges.map((e) => `${e.from}->${e.to}`).sort(),
    ['A->B', 'C->D']
  );
});
