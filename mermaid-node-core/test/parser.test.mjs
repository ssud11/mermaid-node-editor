// Unit tests for mermaid-node-core, run on Node's built-in test runner.
// The acceptance corpus (corpus.json) is driven as a data-driven block here so a
// single `npm test` covers both the corpus and the focused position/edge tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findMermaidBlocks, blockAtLine } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, "corpus.json"), "utf8"));

const normNodes = (ns) => ns.map((n) => ({ id: n.id, label: n.label, shape: n.shape }));
const normEdges = (es) =>
  es.map((e) => (e.label !== undefined ? { from: e.from, to: e.to, label: e.label } : { from: e.from, to: e.to }));
const normSubs = (ss) => ss.map((s) => ({ id: s.id, label: s.label, hasId: s.hasId, members: s.members }));

function isMmdFor(tc) {
  const hasFence = /^\s*(```|~~~)/m.test(tc.input);
  return tc.isMmd === true || (tc.isMmd === undefined && !hasFence);
}

// ── Corpus, case-by-case ─────────────────────────────────────────────────────

for (const tc of corpus) {
  test(`corpus: ${tc.id} — ${tc.note}`, () => {
    const isMmd = isMmdFor(tc);
    const blocks = findMermaidBlocks(tc.input, isMmd); // must never throw
    const lines = tc.input.split(/\r?\n/);

    if (tc.valid === false) {
      if (tc.expectNoBlocks) {
        assert.equal(blocks.length, 0, "expected no blocks for unterminated fence");
        return;
      }
      const nodes = blocks.flatMap((b) => b.nodes || []);
      const edges = blocks.flatMap((b) => b.edges || []);
      assert.equal(nodes.length, 0, "off-contract input must not produce live nodes");
      assert.equal(edges.length, 0, "off-contract input must not produce live edges");
      return;
    }

    let nodes = [];
    let edges = [];
    let subs = [];
    if (tc.combineBlocks) {
      for (const b of blocks) {
        nodes.push(...(b.nodes || []));
        edges.push(...(b.edges || []));
        subs.push(...(b.subgraphs || []));
      }
    } else {
      const b = blocks[0];
      assert.ok(b, "a valid case must return a block");
      nodes = b.nodes;
      edges = b.edges;
      subs = b.subgraphs;
    }

    assert.deepEqual(normNodes(nodes), tc.expectNodes);
    assert.deepEqual(normEdges(edges), normEdges(tc.expectEdges));
    if (tc.expectSubgraphs) assert.deepEqual(normSubs(subs), tc.expectSubgraphs);

    // Positions: every node/edge has a real, in-range span.
    for (const n of nodes) {
      assert.ok(n.line >= 0 && n.startChar >= 0 && n.endChar > n.startChar, `node ${n.id} span`);
      assert.ok(n.endChar <= lines[n.line].length, `node ${n.id} endChar within line`);
    }
    for (const e of edges) {
      assert.ok(e.line >= 0 && e.endChar > e.startChar, `edge ${e.from}->${e.to} span`);
    }
  });
}

// ── Focused position assertions ──────────────────────────────────────────────

test("node span: real columns for id and label content", () => {
  const [b] = findMermaidBlocks("graph TD\nA[Start] --> B[End]", true);
  const a = b.nodes.find((n) => n.id === "A");
  // `A[Start]` is on line 1; the node text starts at col 0 and ends after `]`.
  assert.equal(a.line, 1);
  assert.equal(a.startChar, 0);
  assert.equal(a.endChar, 8); // length of "A[Start]"
  // label content "Start" is inside the brackets: cols 2..7
  assert.equal(a.labelStart, 2);
  assert.equal(a.labelEnd, 7);
  assert.equal("graph TD\nA[Start] --> B[End]".split("\n")[1].slice(a.labelStart, a.labelEnd), "Start");
});

test("quoted label span excludes the quotes", () => {
  const src = 'graph TD\nA["Quoted Label"]';
  const [b] = findMermaidBlocks(src, true);
  const a = b.nodes[0];
  assert.equal(a.quote, '"');
  assert.equal(src.split("\n")[1].slice(a.labelStart, a.labelEnd), "Quoted Label");
});

test("edge span covers from-node start to to-node end", () => {
  const src = "graph TD\nA[Start] --> B[End]";
  const [b] = findMermaidBlocks(src, true);
  const e = b.edges[0];
  assert.equal(e.line, 1);
  assert.equal(e.startChar, 0); // at "A"
  assert.equal(e.endChar, src.split("\n")[1].length); // through "B[End]"
});

test("fenced block carries absolute line numbers", () => {
  const src = "# Doc\n\n```mermaid\ngraph TD\nA[Start] --> B[End]\n```";
  const [b] = findMermaidBlocks(src, false);
  const a = b.nodes.find((n) => n.id === "A");
  assert.equal(a.line, 4); // 0-based absolute line of `A[Start]...`
  assert.equal(b.startLine, 2);
});

test("blockAtLine picks the right block in a multi-block doc", () => {
  const src = "```mermaid\ngraph TD\nA --> B\n```\n\n```mermaid\ngraph TD\nC --> D\n```";
  const blocks = findMermaidBlocks(src, false);
  assert.equal(blocks.length, 2);
  const first = blockAtLine(blocks, 2, false);
  const second = blockAtLine(blocks, 7, false);
  assert.equal(first.edges[0].from, "A");
  assert.equal(second.edges[0].from, "C");
});

// ── subgraph title spans are content-exclusive (slice === value) ──────────

test("subgraph title-only span excludes quote/bracket delimiters", () => {
  // Quoted title-only: idStart/idEnd must slice to the content, NOT '"my title"'.
  const q = 'graph TD\nsubgraph "my title"\n  A\nend';
  const sgQ = findMermaidBlocks(q, true)[0].subgraphs[0];
  const lineQ = q.split("\n")[sgQ.line];
  assert.equal(sgQ.hasId, false);
  assert.equal(lineQ.slice(sgQ.idStart, sgQ.idEnd), "my title");
  assert.equal(lineQ.slice(sgQ.titleStart, sgQ.titleEnd), "my title");

  // Bracketed title-only: same content-exclusive invariant.
  const brk = "graph TD\nsubgraph [my title]\n  A\nend";
  const sgB = findMermaidBlocks(brk, true)[0].subgraphs[0];
  const lineB = brk.split("\n")[sgB.line];
  assert.equal(lineB.slice(sgB.idStart, sgB.idEnd), "my title");
  assert.equal(lineB.slice(sgB.titleStart, sgB.titleEnd), "my title");
});

test("subgraph id+title exposes a content-exclusive titleStart/titleEnd", () => {
  const src = 'graph TD\nsubgraph proc ["the title"]\n  A\nend';
  const sg = findMermaidBlocks(src, true)[0].subgraphs[0];
  const line = src.split("\n")[sg.line];
  assert.equal(sg.hasId, true);
  assert.equal(line.slice(sg.idStart, sg.idEnd), "proc"); // id span unchanged
  assert.equal(line.slice(sg.titleStart, sg.titleEnd), "the title"); // content-only
});

test("subgraph no-space id[title] parses to {id,title,hasId} with correct spans", () => {
  const src = "graph TD\nsubgraph one[The One]\n  A-->B\nend";
  const sg = findMermaidBlocks(src, true)[0].subgraphs[0];
  const line = src.split("\n")[sg.line];
  assert.equal(sg.id, "one");
  assert.equal(sg.label, "The One");
  assert.equal(sg.hasId, true);
  assert.equal(line.slice(sg.idStart, sg.idEnd), "one");
  assert.equal(line.slice(sg.titleStart, sg.titleEnd), "The One");
});

test("never throws on a battery of off-contract / malformed inputs", () => {
  const malformed = [
    "graph TD\nA[Unclosed",
    "graph TD\nA --> B & C",
    "graph TD\nA[[[x]]]",
    "graph TD\nA --> end",
    "```mermaid\ngraph TD\nA --> B", // unterminated fence
    "not a diagram at all",
    "",
    "graph TD\n%%%%%%",
    "graph TD\nA-.-.->B",
    "graph TD\nA[[[hello]]", // asymmetric over-bracket
    "graph TD\nA((x)",
    "graph TD\nA{{{x}}",
    "graph DT\nA-->B", // bogus direction
  ];
  for (const src of malformed) {
    assert.doesNotThrow(() => findMermaidBlocks(src, true));
    assert.doesNotThrow(() => findMermaidBlocks(src, false));
  }
});
