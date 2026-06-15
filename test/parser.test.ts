import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMermaidBlocks, scanNodes, blockAtLine } from '../src/parser';

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

// --- regression: YAML frontmatter (title:/config:) before
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

// --- regression: `;` statement terminators must not drop
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

// --- subgraph id column spans (for go-to-definition / rename) ---

test('parseSubgraph: id columns for `subgraph id [Title]`', () => {
  const b = findMermaidBlocks(['graph TD', '  subgraph AR1 ["Rules loads"]', '  end'].join('\n'), true)[0];
  const sg = b.subgraphs[0];
  const line = '  subgraph AR1 ["Rules loads"]';
  assert.equal(sg.id, 'AR1');
  assert.equal(line.slice(sg.idStart, sg.idEnd), 'AR1');
});

test('parseSubgraph: id columns for a plain `subgraph BR2`', () => {
  const b = findMermaidBlocks(['graph TD', 'subgraph BR2', 'end'].join('\n'), true)[0];
  const sg = b.subgraphs[0];
  assert.equal(sg.id, 'BR2');
  assert.equal('subgraph BR2'.slice(sg.idStart, sg.idEnd), 'BR2');
});

// --- blockAtLine: cursor → block lookup ---

test('blockAtLine (.mmd): always the single block', () => {
  const blocks = findMermaidBlocks(['graph TD', 'A --> B'].join('\n'), true);
  assert.equal(blockAtLine(blocks, 1, true), blocks[0]);
  assert.equal(blockAtLine(blocks, 99, true), blocks[0]);
});

// --- regressions: fence boundaries + inline edge labels ---

test('review#1: an unterminated mermaid fence is not a block (no prose capture)', () => {
  const text = ['# Doc', '', '```mermaid', 'graph TD', 'A[x] --> B[y]', '', 'Plain prose with an A in it.'].join('\n');
  assert.equal(findMermaidBlocks(text, false).length, 0);
});

test('review#1: a ```mermaid nested inside an outer ```` fence is not a block', () => {
  const text = ['Example:', '````markdown', '```mermaid', 'graph TD', 'A[x] --> B[y]', '```', '````'].join('\n');
  assert.equal(findMermaidBlocks(text, false).length, 0);
});

test('review#4: a single-word inline edge label is not a phantom node', () => {
  const b = findMermaidBlocks(['graph LR', 'A[Start] -- check --> B[End]'].join('\n'), true)[0];
  assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ['A->B']);
  assert.deepEqual(b.nodes.map((n) => n.id).sort(), ['A', 'B']);
});

test('review#4: a glued inline edge label is stripped too', () => {
  const b = findMermaidBlocks(['graph LR', 'A[Start] --check--> B[End]'].join('\n'), true)[0];
  assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ['A->B']);
});

test('review#4: chained edges keep the middle node (no over-strip)', () => {
  const b = findMermaidBlocks(['graph LR', 'A --> B --> C'].join('\n'), true)[0];
  assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ['A->B', 'B->C']);
});

test('blockAtLine (markdown): picks the block containing the line, else undefined', () => {
  const text = ['# h', '```mermaid', 'graph TD', 'A --> B', '```', 'prose', '```mermaid', 'flowchart LR', 'X --> Y', '```'].join('\n');
  const blocks = findMermaidBlocks(text, false);
  assert.equal(blockAtLine(blocks, 3, false), blocks[0]); // inside first fence
  assert.equal(blockAtLine(blocks, 8, false), blocks[1]); // inside second fence
  assert.equal(blockAtLine(blocks, 5, false), undefined); // the prose line
});

// ===== P1 enrichment: edge labels =====
const edges1 = (line: string) => findMermaidBlocks(['graph LR', line].join('\n'), true)[0].edges;

test('edge label: pipe form `A -->|yes| B`', () => {
  const e = edges1('A -->|yes| B');
  assert.equal(e.length, 1);
  assert.equal(e[0].label, 'yes');
  assert.deepEqual([e[0].from, e[0].to], ['A', 'B']);
});

test('edge label: pipe with surrounding spaces `A --> |no| B`', () => {
  assert.equal(edges1('A --> |no| B')[0].label, 'no');
});

test('edge label: inline form `A -- text --> B` (no spurious node — the documented fix)', () => {
  const b = findMermaidBlocks(['graph LR', 'A[a] -- text --> B[b]'].join('\n'), true)[0];
  assert.deepEqual(b.edges.map((x) => `${x.from}->${x.to}`), ['A->B']);
  assert.equal(b.edges[0].label, 'text');
  assert.deepEqual(b.nodes.map((n) => n.id).sort(), ['A', 'B']); // "text" is NOT a node
});

test('edge label: inline thick `A == t ==> B` and dotted `A -. t .-> B`', () => {
  assert.equal(edges1('A == t ==> B')[0].label, 't');
  assert.equal(edges1('A -. d .-> B')[0].label, 'd');
});

test('edge label: none → undefined', () => {
  assert.equal(edges1('A --> B')[0].label, undefined);
});

// ===== P1 enrichment: edge kinds =====
const kind1 = (line: string) => edges1(line)[0].kind;

test('edge kind: solid arrow `-->`', () => {
  assert.deepEqual(kind1('A --> B'), { stroke: 'solid', head: 'arrow', bidirectional: false });
});
test('edge kind: solid open `---`', () => {
  assert.deepEqual(kind1('A --- B'), { stroke: 'solid', head: 'open', bidirectional: false });
});
test('edge kind: dotted arrow `-.->`', () => {
  assert.deepEqual(kind1('A -.-> B'), { stroke: 'dotted', head: 'arrow', bidirectional: false });
});
test('edge kind: thick arrow `==>`', () => {
  assert.deepEqual(kind1('A ==> B'), { stroke: 'thick', head: 'arrow', bidirectional: false });
});
test('edge kind: cross `--x` and circle `--o`', () => {
  assert.equal(kind1('A --x B').head, 'cross');
  assert.equal(kind1('A --o B').head, 'circle');
});
test('edge kind: bidirectional `<-->`, `o--o`, `x--x`', () => {
  assert.deepEqual(kind1('A <--> B'), { stroke: 'solid', head: 'arrow', bidirectional: true });
  assert.deepEqual(kind1('A o--o B'), { stroke: 'solid', head: 'circle', bidirectional: true });
  assert.deepEqual(kind1('A x--x B'), { stroke: 'solid', head: 'cross', bidirectional: true });
});
test('edge kind: thick open `===` and dotted open `-.-`', () => {
  assert.deepEqual(kind1('A === B'), { stroke: 'thick', head: 'open', bidirectional: false });
  assert.deepEqual(kind1('A -.- B'), { stroke: 'dotted', head: 'open', bidirectional: false });
});

test('edge kind+label: chained mixed `A -->|a| B -.-> C`', () => {
  const e = edges1('A -->|a| B -.-> C');
  assert.equal(e.length, 2);
  assert.deepEqual([e[0].from, e[0].to, e[0].label, e[0].kind.stroke], ['A', 'B', 'a', 'solid']);
  assert.deepEqual([e[1].from, e[1].to, e[1].label, e[1].kind.stroke], ['B', 'C', undefined, 'dotted']);
});

// ===== P1 enrichment: subgraph membership =====
test('subgraph members: declared nodes belong to the subgraph', () => {
  const b = findMermaidBlocks(
    ['graph TD', 'subgraph S [Phase]', 'A[a] --> B[b]', 'end', 'B --> C[c]'].join('\n'),
    true
  )[0];
  const s = b.subgraphs.find((x) => x.id === 'S')!;
  assert.deepEqual(s.members, ['A', 'B']); // C is outside; first-seen-outside not re-added
});

test('subgraph members: nested subgraph is a member of its parent; inner nodes belong to inner', () => {
  const b = findMermaidBlocks(
    ['graph TD', 'subgraph Outer', 'O[o]', 'subgraph Inner', 'I[i]', 'end', 'end'].join('\n'),
    true
  )[0];
  const outer = b.subgraphs.find((x) => x.id === 'Outer')!;
  const inner = b.subgraphs.find((x) => x.id === 'Inner')!;
  assert.deepEqual(outer.members, ['O', 'Inner']); // O + the nested subgraph
  assert.deepEqual(inner.members, ['I']);
});

test('subgraph members: a node defined OUTSIDE then referenced inside stays the outsider', () => {
  const b = findMermaidBlocks(
    ['graph LR', 'A[a] --> X[x]', 'subgraph S', 'X --> B[b]', 'end'].join('\n'),
    true
  )[0];
  const s = b.subgraphs.find((x) => x.id === 'S')!;
  assert.deepEqual(s.members, ['B']); // X first-seen outside → not a member; only B
});

// ===== P1 adversarial-sweep regressions (bugs found + fixed by the verify workflow) =====

test('sweep: length-variant dotted arrows `-...->`/`-....->` have NO label', () => {
  for (const op of ['-.->', '-..->', '-...->', '-....->']) {
    const e = edges1(`A ${op} B`)[0];
    assert.equal(e.label, undefined, `${op} should carry no label`);
    assert.deepEqual(e.kind, { stroke: 'dotted', head: 'arrow', bidirectional: false });
  }
});

test('sweep: bidirectional is solid-only — `<==>` is NOT bidirectional', () => {
  assert.equal(kind1('A <==> B').bidirectional, false); // thick can't be bidirectional
  assert.equal(kind1('A <--> B').bidirectional, true); // solid still is
});

test('sweep: pipe label with parens/brackets does not leak phantom nodes', () => {
  const b1 = findMermaidBlocks(['graph LR', 'A -->|check(x)| B'].join('\n'), true)[0];
  assert.deepEqual(b1.nodes.map((n) => n.id), []); // `check` is label text, not a node
  assert.equal(b1.edges[0].label, 'check(x)');
  const b2 = findMermaidBlocks(['graph LR', 'A -->|foo(x) bar(y)| B'].join('\n'), true)[0];
  assert.deepEqual(b2.nodes.map((n) => n.id), []);
  assert.equal(b2.edges[0].label, 'foo(x) bar(y)');
  assert.equal(findMermaidBlocks(['graph LR', 'A -->|arr[0]| B'].join('\n'), true)[0].edges[0].label, 'arr[0]');
});

test('sweep: an inline `%% comment` does not drop the edge', () => {
  const e = edges1('A --> B %% this is a comment');
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].from, e[0].to], ['A', 'B']);
});

test('sweep: surrounding quotes are stripped from edge labels', () => {
  assert.equal(edges1('A -->|"hello world"| B')[0].label, 'hello world');
  assert.equal(edges1('A -- "hi" --> B')[0].label, 'hi');
  assert.equal(edges1('A -->|"step 1<br>step 2"| B')[0].label, 'step 1<br>step 2');
});

test('sweep: bare-identifier node declarations are captured (nodes + members)', () => {
  const b = findMermaidBlocks(
    ['graph TD', 'subgraph S1', 'Alpha', 'Beta[Labelled]', 'end'].join('\n'),
    true
  )[0];
  assert.deepEqual(b.nodes.map((n) => n.id).sort(), ['Alpha', 'Beta']); // Alpha is bare, still a node
  assert.deepEqual(b.subgraphs.find((x) => x.id === 'S1')!.members, ['Alpha', 'Beta']);
});

test('sweep: the diagram-type line is not mistaken for a bare node', () => {
  const b = findMermaidBlocks(['flowchart', 'A --> B'].join('\n'), true)[0];
  assert.deepEqual(b.nodes.map((n) => n.id), []); // `flowchart` is reserved, not a node
});

// ===== re-verify regressions: the fixes above must not corrupt labels containing %% or nested quotes =====

test('reverify: a `%%` INSIDE a node/edge label is not stripped as a comment', () => {
  const b = findMermaidBlocks(['graph LR', 'A["x %% y"] --> B'].join('\n'), true)[0];
  assert.equal(b.nodes.find((n) => n.id === 'A')!.label, 'x %% y'); // label intact
  assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ['A->B']);
  assert.equal(edges1('A -->|a %% b| B')[0].label, 'a %% b'); // pipe label intact
});

test('reverify: only a FULLY-quoted edge label is unwrapped (`"a" "b"` keeps quotes)', () => {
  assert.equal(edges1('A -->|"a" "b"| B')[0].label, '"a" "b"'); // not unwrapped
  assert.equal(edges1('A -->|a "b" c| B')[0].label, 'a "b" c'); // internal quotes survive
  assert.equal(edges1('A -->|"solo"| B')[0].label, 'solo'); // fully quoted → unwrapped
});

test('reverify: a true inline `%%` comment is still stripped (edge survives)', () => {
  const e = edges1('A --> B %% trailing note');
  assert.deepEqual([e.length, e[0].from, e[0].to], [1, 'A', 'B']);
});

// ===== round-2 re-verify regressions (found resuming the adversarial workflow) =====

test('reverify2: `%%` inside an INLINE edge label is not stripped', () => {
  const e = edges1('A -- x %% y --> B');
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].from, e[0].to, e[0].label], ['A', 'B', 'x %% y']);
});

test('reverify2: directive lines never yield phantom nodes (bracket-like values)', () => {
  const none = (line: string) =>
    findMermaidBlocks(['graph LR', line].join('\n'), true)[0].nodes.map((n) => n.id);
  assert.deepEqual(none('style A color:rgb(255,0,0)'), []); // `rgb(...)` is a CSS value
  assert.deepEqual(none('classDef myClass color(red)'), []);
  assert.deepEqual(none('linkStyle 0 stroke:rgba(0,0,0,0.5)'), []);
  // `click A myFunc(arg)` references node A (defined elsewhere); the directive adds no node
  const b = findMermaidBlocks(['graph LR', 'A[Node]', 'click A myFunc(arg)'].join('\n'), true)[0];
  assert.deepEqual(b.nodes.map((n) => n.id), ['A']);
});
