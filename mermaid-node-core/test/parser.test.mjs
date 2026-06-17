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

test("asymmetric >] quoted label strips quotes with a content-exclusive span", () => {
  // The >] shape must report quote='"' and a content-only span just like [].
  const asym = 'flowchart TD\nA>"quoted label"]';
  const rect = 'flowchart TD\nA["quoted label"]';
  const na = findMermaidBlocks(asym, true)[0].nodes[0];
  const nr = findMermaidBlocks(rect, true)[0].nodes[0];
  assert.equal(na.shape, ">]");
  assert.equal(na.quote, '"');
  assert.equal(na.label, "quoted label");
  // span slices to the content, excluding the surrounding quotes
  assert.equal(asym.split("\n")[1].slice(na.labelStart, na.labelEnd), "quoted label");
  // …and the label value matches the rectangle baseline exactly
  assert.equal(na.label, nr.label);
  assert.equal(na.quote, nr.quote);

  // single-quoted variant too
  const sq = findMermaidBlocks("flowchart TD\nA>'sq label']", true)[0].nodes[0];
  assert.equal(sq.quote, "'");
  assert.equal(sq.label, "sq label");
});

test("styling/accessibility directive lines are consumed, not block-fatal", () => {
  // Each directive keyword on its own line must be ignored, leaving the real
  // nodes/edges intact (not a whole-block supported:false).
  const cases = [
    "style A fill:#f00",
    "click A href \"u\"",
    "classDef c fill:red",
    "class A c",
    "linkStyle 0 stroke:red",
    "accTitle: a title",
    "accDescr: a description",
  ];
  for (const directive of cases) {
    const src = `flowchart TD\nA[Start] --> B[End]\n${directive}`;
    const b = findMermaidBlocks(src, true)[0];
    assert.equal(b.supported, true, `directive '${directive}' should not fail the block`);
    assert.deepEqual(b.edges.map((e) => ({ from: e.from, to: e.to })), [{ from: "A", to: "B" }]);
    assert.equal(b.nodes.length, 2);
  }
  // the accDescr brace block spans multiple lines and is consumed through `}`
  const blockSrc = "flowchart TD\naccDescr {\n  one\n  two\n}\nA --> B";
  const bb = findMermaidBlocks(blockSrc, true)[0];
  assert.equal(bb.supported, true);
  assert.deepEqual(bb.edges.map((e) => ({ from: e.from, to: e.to })), [{ from: "A", to: "B" }]);
});

test("an id that merely starts with a directive keyword is a real node", () => {
  // `styleA`/`classroom` are NOT directives — the keyword must be a whole token.
  const node = findMermaidBlocks("flowchart TD\nstyleA[x] --> B", true)[0];
  assert.equal(node.nodes[0].id, "styleA");
  assert.equal(node.edges[0].from, "styleA");
  const edge = findMermaidBlocks("flowchart TD\nclassroom --> B", true)[0];
  assert.equal(edge.edges[0].from, "classroom");
});

test("mixed dash+pipe edge does NOT silently parse with leaked pipe chars", () => {
  // `A --|label|--> B` is non-standard; the chosen behavior is a graceful WARN
  // (no live edge) rather than the old false-green label='|label|'.
  for (const src of ["flowchart TD\nA --|label|--> B", "flowchart TD\nA ==|label|==> B"]) {
    const b = findMermaidBlocks(src, true)[0];
    const leaked = (b.edges || []).some((e) => e.label === "|label|");
    assert.equal(leaked, false, `pipe chars must never leak into the label for: ${src}`);
    // it warns (supported:false / no live edge), not a silent success
    assert.equal((b.edges || []).length, 0);
  }
  // the canonical forms still produce the clean label
  assert.equal(findMermaidBlocks("flowchart TD\nA -->|label| B", true)[0].edges[0].label, "label");
  assert.equal(findMermaidBlocks("flowchart TD\nA -- label --> B", true)[0].edges[0].label, "label");
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

test("inline-dash/thick edge label: full family parses to the stripped label", () => {
  // Any closing-shaft length is one arrow — the extra shaft chars must not leak.
  const longShaft = [
    ["graph TD\nA -- text ---> B", "text"],
    ["graph TD\nA -- text ----> B", "text"],
    ["graph TD\nA -- text -----> B", "text"],
    ["graph TD\nA == text ===> B", "text"],
    ["graph TD\nA == text ====> B", "text"],
  ];
  for (const [src, want] of longShaft) {
    const b = findMermaidBlocks(src, true)[0];
    assert.equal(b.edges.length, 1, `one edge for: ${src}`);
    assert.equal(b.edges[0].label, want, `no shaft leak for: ${src}`);
  }
  // Quoted inline labels strip the surrounding quotes, like the pipe form.
  const quoted = [
    ['graph TD\nA -- "q label" --> B', "q label"],
    ["graph TD\nA -- 'q label' --> B", "q label"],
    ['graph TD\nA == "q label" ==> B', "q label"],
  ];
  for (const [src, want] of quoted) {
    assert.equal(findMermaidBlocks(src, true)[0].edges[0].label, want, `quotes stripped for: ${src}`);
  }
  // Internal hyphens/pipes inside the label are preserved (not terminators).
  assert.equal(findMermaidBlocks("graph TD\nA -- a-b-c --> B", true)[0].edges[0].label, "a-b-c");
  assert.equal(findMermaidBlocks("graph TD\nA -- one|two --> B", true)[0].edges[0].label, "one|two");
  // Canonical controls — the short-shaft and pipe forms still strip correctly.
  assert.equal(findMermaidBlocks("graph TD\nA -- label --> B", true)[0].edges[0].label, "label");
  assert.equal(findMermaidBlocks("graph TD\nA -->|label| B", true)[0].edges[0].label, "label");
});

test("bare hyphenated-id node span is bounded to the kept id (slice === id)", () => {
  // `receive-order` truncates to `receive`; the node span must cover ONLY the kept
  // id so a span-rename can't overwrite the discarded `-order` tail.
  const src = "graph TD\nreceive-order";
  const n = findMermaidBlocks(src, true)[0].nodes[0];
  const line = src.split("\n")[n.line];
  assert.equal(n.id, "receive");
  assert.equal(n.label, "receive");
  assert.equal(line.slice(n.startChar, n.endChar), "receive");
  assert.equal(line.slice(n.labelStart, n.labelEnd), "receive");
  // A plain (non-hyphenated) bare id keeps the same invariant.
  const src2 = "graph TD\nplain";
  const n2 = findMermaidBlocks(src2, true)[0].nodes[0];
  assert.equal(src2.split("\n")[n2.line].slice(n2.startChar, n2.endChar), "plain");
});

test("asymmetric label may not begin with an unquoted opening bracket", () => {
  // `A>(text)]` / `A>{x}]` must WARN (no live node), not silently capture the bracket.
  for (const src of ["graph TD\nA>(text)]", "graph TD\nA>{x}]"]) {
    const b = findMermaidBlocks(src, true)[0];
    assert.equal((b.nodes || []).length, 0, `no live node for: ${src}`);
    assert.equal(b.supported, false, `block warns (supported:false) for: ${src}`);
  }
  // A QUOTED asymmetric label with an inner bracket is still valid (quotes stripped).
  const q = findMermaidBlocks('graph TD\nA>"(text)"]', true)[0].nodes[0];
  assert.equal(q.shape, ">]");
  assert.equal(q.label, "(text)");
});

test("diagramType strips a same-line inline comment from the header", () => {
  // A commented header line `graph TD %% note` must yield diagramType 'graph TD',
  // not keep the trailing comment — while the nodes/edges parse normally.
  const b = findMermaidBlocks("graph TD %% layout note\nA --> B", true)[0];
  assert.equal(b.diagramType, "graph TD");
  assert.equal(b.supported, true);
  assert.deepEqual(b.edges.map((e) => ({ from: e.from, to: e.to })), [{ from: "A", to: "B" }]);
  // own-line comment control is unaffected
  const c = findMermaidBlocks("graph TD\n%% layout note\nA --> B", true)[0];
  assert.equal(c.diagramType, "graph TD");
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
