// Unit tests for mermaid-node-core, run on Node's built-in test runner.
// The acceptance corpus (corpus.json) is driven as a data-driven block here so a
// single `npm test` covers both the corpus and the focused position/edge tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findMermaidBlocks, blockAtLine } from "../src/index.js";
import { checkSpans } from "./span-net.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, "corpus.json"), "utf8"));

const normNodes = (ns) => ns.map((n) => ({ id: n.id, label: n.label, shape: n.shape }));
const normEdges = (es) =>
  es.map((e) => (e.label !== undefined ? { from: e.from, to: e.to, label: e.label } : { from: e.from, to: e.to }));
const normSubs = (ss) => ss.map((s) => ({ id: s.id, label: s.label, hasId: s.hasId, members: s.members }));

// Distinct warning codes a set of blocks emitted, sorted (order-insensitive set
// compare). Also verifies each warning carries a real in-range line + a message.
const warnCodes = (blocks) =>
  [...new Set(blocks.flatMap((b) => (b.warnings || []).map((w) => w.code)))].sort();
function assertWarnings(blocks, expectWarnings, lines, id) {
  assert.deepEqual(warnCodes(blocks), [...expectWarnings].sort(), `warnings codes (${id})`);
  for (const b of blocks) {
    for (const w of b.warnings || []) {
      assert.ok(typeof w.line === "number" && w.line >= 0 && lines[w.line] !== undefined, `warning ${w.code} in-range line (${id})`);
      assert.ok(typeof w.message === "string" && w.message.length > 0, `warning ${w.code} has a message (${id})`);
    }
  }
}

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
      // UN-MASK (supported axis): pin it when the case asks. Default for
      // valid:false leaves the axis open (a graceful-skip block may be
      // supported:true with an empty model, e.g. a dropped reserved endpoint).
      if (tc.expectSupported !== undefined) {
        for (const b of blocks) assert.equal(b.supported, tc.expectSupported, `valid:false supported axis (${tc.id})`);
      }
      // A graceful-WARN valid:false case (supported:true, empty model) may still
      // carry yellow-lint warnings (e.g. a dropped reserved edge endpoint). Pin the
      // exact code set when the case asks via expectWarnings.
      if (tc.expectWarnings !== undefined) assertWarnings(blocks, tc.expectWarnings, lines, tc.id);
      return;
    }

    let nodes = [];
    let edges = [];
    let subs = [];
    let supBlocks = [];
    if (tc.combineBlocks) {
      supBlocks = blocks;
      for (const b of blocks) {
        nodes.push(...(b.nodes || []));
        edges.push(...(b.edges || []));
        subs.push(...(b.subgraphs || []));
      }
    } else {
      const b = blocks[0];
      assert.ok(b, "a valid case must return a block");
      supBlocks = [b];
      nodes = b.nodes;
      edges = b.edges;
      subs = b.subgraphs;
    }

    // UN-MASK (supported axis): the block(s) under check MUST be supported:true
    // (overridable per case via expectSupported). Previously this data-driven
    // block asserted only nodes/edges/spans and never referenced b.supported, so
    // a case whose expectNodes/expectEdges were both [] passed on []==[] even when
    // the parser had failed the whole block — the same mask run-corpus.mjs had.
    const wantSupported = tc.expectSupported === undefined ? true : tc.expectSupported;
    for (const b of supBlocks) assert.equal(b.supported, wantSupported, `valid:true supported axis (${tc.id})`);

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

    // Span-CONTENT invariant: a node's [startChar,endChar) must slice to the
    // expected text (the kept id for a hyphen-truncated id; the whole node text
    // for a plain shaped id) so a span-edit targets only the kept content.
    if (tc.expectNodeSpanSlices) {
      for (const [nodeId, want] of Object.entries(tc.expectNodeSpanSlices)) {
        const n = nodes.find((x) => x.id === nodeId);
        assert.ok(n, `expectNodeSpanSlices: node ${nodeId} present (${tc.id})`);
        assert.equal(lines[n.line].slice(n.startChar, n.endChar), want, `node ${nodeId} span slice (${tc.id})`);
      }
    }

    // Universal span-invariant net: on EVERY valid case, every node and subgraph
    // must have spans that slice to exactly the content the model claims (label,
    // node decl, id/title) — expected slices computed from the input + parsed
    // values, never hand-listed. This is the catch-all that proves a span axis
    // didn't silently degenerate (the zero-width-label-span class), per construct.
    for (const b of supBlocks) {
      checkSpans(b, lines, (msg) => assert.fail(`span-net (${tc.id}): ${msg}`));
    }

    // Warning-channel assertion: pin the exact yellow-lint code set when the case
    // asks (the v1.4 renders-it-but-warn families certify their advisory here);
    // default is NO warnings, so a case that starts emitting a spurious warning
    // fails even without opting in.
    assertWarnings(supBlocks, tc.expectWarnings === undefined ? [] : tc.expectWarnings, lines, tc.id);
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

test("bare hyphenated-id node span covers the FULL id (slice === id)", () => {
  // `receive-order` is read as the full id; the node span covers all of it so
  // slice(startChar, endChar) === "receive-order" — the rename target is exact.
  const src = "graph TD\nreceive-order";
  const n = findMermaidBlocks(src, true)[0].nodes[0];
  const line = src.split("\n")[n.line];
  assert.equal(n.id, "receive-order");
  assert.equal(n.label, "receive-order");
  assert.equal(line.slice(n.startChar, n.endChar), "receive-order");
  assert.equal(line.slice(n.labelStart, n.labelEnd), "receive-order");
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

test("bare thick arrow accepts every shaft length, like the bare dash arrow", () => {
  // The bare (unlabeled) thick arrow must accept any shaft length ending in `>`
  // — the same length-variant family the bare-dash and labeled-thick forms accept.
  for (const src of [
    "graph TD\nA ==> B",
    "graph TD\nA ===> B",
    "graph TD\nA ====> B",
    "graph TD\nA===>B",
  ]) {
    const b = findMermaidBlocks(src, true)[0];
    assert.equal(b.supported, true, `parses: ${src}`);
    assert.equal(b.parseError, undefined, `no parse error: ${src}`);
    assert.deepEqual(b.edges.map((e) => ({ from: e.from, to: e.to })), [{ from: "A", to: "B" }], `one edge A->B: ${src}`);
  }
  // A mixed block keeps both edges — neither line fails the whole block.
  const mixed = findMermaidBlocks("graph TD\nA-->B\nB===>C", true)[0];
  assert.deepEqual(mixed.edges.map((e) => ({ from: e.from, to: e.to })), [{ from: "A", to: "B" }, { from: "B", to: "C" }]);
  // The headless thick link `===`/`====` (no `>`) is still a distinct open link.
  for (const src of ["graph TD\nA === B", "graph TD\nA ==== B"]) {
    assert.deepEqual(findMermaidBlocks(src, true)[0].edges.map((e) => ({ from: e.from, to: e.to })), [{ from: "A", to: "B" }], `open link: ${src}`);
  }
});

test("a reserved keyword leading an edge does not swallow the same-line destination", () => {
  // `style[L] --> B[End]` is off-contract (reserved id as edge source). The directive
  // rule must NOT consume the whole line and silently drop B — the destination node
  // survives in the best-effort model. v1.6 #3: a reserved edge endpoint is Mermaid-
  // rejected, so the block is supported:false (the edge is dropped, B kept).
  for (const src of ["flowchart TD\nstyle[Label] --> B[End]", "flowchart TD\nstyle[L] ==> B[End]"]) {
    const b = findMermaidBlocks(src, true)[0];
    assert.equal(b.supported, false, `reserved source → supported:false: ${src}`);
    assert.deepEqual(b.nodes.map((n) => n.id), ["B"], `destination B survives: ${src}`);
    assert.equal(b.edges.length, 0, `reserved-source edge dropped: ${src}`);
  }
  // Control: a PLAIN directive line (no edge operator) is still consumed+ignored,
  // and the real node/edge around it survive — the edge-aware tightening did not
  // un-fix the directive-class behavior.
  const plain = findMermaidBlocks(
    'flowchart TD\nA[Start] --> B[End]\nstyle A fill:red\nclassDef x fill:blue\nclick A href "u"\naccDescr { some text }',
    true,
  )[0];
  assert.equal(plain.supported, true);
  assert.deepEqual(plain.nodes.map((n) => n.id), ["A", "B"]);
  assert.deepEqual(plain.edges.map((e) => ({ from: e.from, to: e.to })), [{ from: "A", to: "B" }]);
});

test("bare subgraph (no id/title) has an in-bounds, non-OOB editable span", () => {
  // A header-less `subgraph` line must not emit a zero-width span one column past
  // end-of-line — the span is clamped to the `subgraph` keyword token, so
  // idStart < idEnd <= line.length and slice(idStart, idEnd) is in-bounds.
  const src = "flowchart TD\nsubgraph\n A-->B\nend";
  const sg = findMermaidBlocks(src, true)[0].subgraphs[0];
  const line = src.split("\n")[sg.line];
  assert.equal(sg.hasId, false);
  assert.equal(sg.id, "");
  assert.ok(sg.idStart >= 0 && sg.idEnd > sg.idStart, "span is non-degenerate");
  assert.ok(sg.idEnd <= line.length, "span end is in-bounds");
  assert.equal(line.slice(sg.idStart, sg.idEnd), "subgraph");
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

// ── Family invariants (inline-label, reserved-node, hyphenated-span) ───────

// Inline-dash/thick LABELED edge family: {close-kind: arrow vs OPEN} × {shaft 2..5}
// × {label: quoted/unquoted}. EVERY arm must be exactly ONE labeled edge, never a
// phantom node from the label text and never a whole-block failure.
test("inline-label edge family (v1.6): an arrow-close or ≥3-char open-close arm is ONE labeled edge", () => {
  // RENDERS arms only — an ARROW close (`-->`), or a HEAD-LESS open close of ≥3
  // dash/equals (`---`/`===`+). Each is ONE labeled edge A->B.
  const arms = [
    ["A -- lbl --> B", "lbl"], ["A -- lbl ---> B", "lbl"], ["A -- lbl ----> B", "lbl"],
    ["A -- lbl --- B", "lbl"], ["A -- lbl ---- B", "lbl"], ["A -- lbl ----- B", "lbl"],
    ["A == lbl ==> B", "lbl"], ["A == lbl ===> B", "lbl"],
    ["A == lbl === B", "lbl"], ["A == lbl ==== B", "lbl"],
    ['A -- "q l" --> B', "q l"], ['A -- "q l" --- B', "q l"],
    ['A == "q l" ==> B', "q l"], ['A == "q l" === B', "q l"],
  ];
  for (const [body, label] of arms) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.equal(b.supported, true, `${body}: supported`);
    assert.equal(b.parseError, undefined, `${body}: no parseError`);
    assert.equal(b.nodes.length, 0, `${body}: no phantom node`);
    assert.deepEqual(
      b.edges.map((e) => ({ from: e.from, to: e.to, label: e.label })),
      [{ from: "A", to: "B", label }],
      `${body}: ONE labeled edge A->B`,
    );
  }
});

test("inline-label edge family (v1.6): a 2-char head-less open close is Mermaid-rejected → no labeled edge", () => {
  // v1.6 #1b — REAL Mermaid REJECTS a labeled edge whose head-less close is only 2
  // dash/equals chars (`A -- lbl -- B`, `A == lbl == B`, `A -- 'q l' -- B` → Parse /
  // Lexical error; the minimum head-less open close is `---`/`===`). No phantom labeled
  // edge is fabricated. (The bare `--` close degrades to a non-fatal skip so a multi-
  // line block isn't nuked; the standalone forms here carry no live A->B labeled edge.)
  for (const body of ["A -- lbl -- B", "A -- 'q l' -- B"]) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.equal(b.edges.length, 0, `${body}: no fabricated labeled edge`);
  }
  // the thick 2-char close is honestly supported:false
  const thick = findMermaidBlocks("graph TD\nA == lbl == B", true)[0];
  assert.equal(thick.supported, false, "A == lbl == B: Mermaid-rejects → supported:false");
  assert.equal(thick.edges.length, 0, "no fabricated labeled edge");
});

test("inline-label edge family (v1.6): a glued embedded ≥3-dash run splits into a middle node (matches Mermaid)", () => {
  // REAL Mermaid lexes a glued `---` (3+ dashes) inside what looks like a label as a
  // LINK: `A -- a---b ---- B` → A -[label a]-> b, b -> B (a middle node `b`), NOT one
  // edge labeled `a---b`. A glued `--` (2 dashes) — `A -- a--b --- B` — is Mermaid-
  // rejected (the 2-dash run is neither a ≥3 open close nor an arrow). Both pinned.
  const triple = findMermaidBlocks("graph TD\nA -- a---b ---- B", true)[0];
  assert.deepEqual(
    triple.edges.map((e) => `${e.from}->${e.to}`),
    ["A->b", "b->B"],
    "A -- a---b ---- B: chained edge through middle node b",
  );
  assert.equal(triple.edges.find((e) => e.from === "A" && e.to === "b").label, "a", "first edge label is `a`");
  // the glued `--` (2-dash) form does not fabricate a single edge labeled `a--b`
  const dbl = findMermaidBlocks("graph TD\nA -- a--b --- B", true)[0];
  assert.equal(dbl.edges.every((e) => e.label !== "a--b"), true, "no edge labeled `a--b` (Mermaid rejects this form)");
});

// Reserved-keyword family: {keyword} × {standalone-shaped, edge-endpoint}. A
// standalone shaped reserved keyword is skipped, the surrounding edges survive
// (no whole-block data loss); a reserved edge endpoint drops only that edge.
test("reserved-keyword family (v1.6): a standalone lowercase-reserved shaped node is supported:false; an unreserved keyword is a normal node", () => {
  // v1.6 #1a/#3 — REAL Mermaid REJECTS only the EXACT lowercase reserved tokens as a
  // shaped node id (`style[X]`, `graph[X]`, … → Parse error), so the block is
  // supported:false (best-effort: no node, surrounding edges kept). `direction`,
  // `click`, `default` are NOT reserved (Mermaid renders `direction[X]` as a node), so
  // they parse as ordinary nodes — supported:true.
  for (const kw of ["style", "graph", "flowchart", "subgraph", "classDef", "class", "linkStyle", "end"]) {
    const b = findMermaidBlocks(`graph TD\nA-->B\n${kw}[X]\nC-->D`, true)[0];
    assert.equal(b.supported, false, `${kw}[X]: Mermaid-rejects → supported:false`);
    assert.equal(b.nodes.length, 0, `${kw}[X]: dropped, no node`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"], `${kw}[X]: surrounding edges survive in the best-effort model`);
  }
  for (const kw of ["direction", "click", "default"]) {
    const b = findMermaidBlocks(`graph TD\nA-->B\n${kw}[X]\nC-->D`, true)[0];
    assert.equal(b.supported, true, `${kw}[X]: not reserved (renders) → supported:true`);
    assert.deepEqual(b.nodes.map((n) => n.id), [kw], `${kw}[X]: a normal node`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"], `${kw}[X]: edges`);
  }
});

test("reserved-keyword family: a bare `end` still terminates a subgraph (not eaten by recovery)", () => {
  const b = findMermaidBlocks("graph TD\nsubgraph S\nA-->B\nend\nC-->D", true)[0];
  assert.equal(b.supported, true);
  assert.deepEqual(b.subgraphs.map((s) => s.id), ["S"]);
  assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"]);
  // and a SHAPED end[X] inside a subgraph is recovered (no node) while the bare end
  // still closes it — but `end[X]` is a Mermaid-REJECTS form, so the block is now
  // supported:false (v1.6 #3). The bare `end` terminator + surrounding edges are
  // still correctly modelled (best-effort).
  const b2 = findMermaidBlocks("graph TD\nsubgraph S\nA-->B\nend[X]\nend\nC-->D", true)[0];
  assert.equal(b2.supported, false);
  assert.deepEqual(b2.subgraphs.map((s) => s.id), ["S"]);
  assert.deepEqual(b2.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"]);
});

test("reserved-keyword family (v1.6): a reserved edge endpoint makes the block supported:false; surrounding edges stay in the model", () => {
  // v1.6 #3 — a reserved keyword as an edge endpoint is a Mermaid-REJECTS form (Parse
  // error). The block is supported:false; the best-effort model still drops only that
  // edge and keeps the surrounding A->B / C->D.
  for (const kw of ["end", "style", "class", "graph"]) {
    const b = findMermaidBlocks(`graph TD\nA-->B\nX-->${kw}\nC-->D`, true)[0];
    assert.equal(b.supported, false, `X-->${kw}: Mermaid-rejects → supported:false`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"], `X-->${kw}: only that edge dropped`);
  }
});

// Hyphenated-span family: {bare, shaped} × {hyphenated, plain}. The node span must
// cover the FULL declaration text for a shaped node (id + shape), including for
// hyphenated ids (the contract: read the full id, never truncate).
test("hyphenated-span family: a SHAPED hyphenated id's span covers the whole declaration (slice === id+shape)", () => {
  const cases = [
    ["send-email[Label]",  "send-email"],
    ["send-email(R)",      "send-email"],
    ["send-email{D}",      "send-email"],
    ["send-email([S])",    "send-email"],
    ["send-email[[Sub]]",  "send-email"],
  ];
  for (const [body, wantId] of cases) {
    const src = `graph TD\n${body}`;
    const n = findMermaidBlocks(src, true)[0].nodes[0];
    assert.equal(n.id, wantId, `${body}: id is full id ${wantId}`);
    assert.equal(src.split("\n")[n.line].slice(n.startChar, n.endChar), body, `${body}: span covers whole declaration`);
  }
  // multi-hyphen
  const n2 = findMermaidBlocks("graph TD\na-b-c-d[Z]", true)[0].nodes[0];
  assert.equal(n2.id, "a-b-c-d");
  assert.equal("graph TD\na-b-c-d[Z]".split("\n")[n2.line].slice(n2.startChar, n2.endChar), "a-b-c-d[Z]");
  // as an edge source
  const b3 = findMermaidBlocks("graph TD\nsend-email[L] --> B", true)[0];
  const ns = b3.nodes.find((x) => x.id === "send-email");
  assert.equal("graph TD\nsend-email[L] --> B".split("\n")[ns.line].slice(ns.startChar, ns.endChar), "send-email[L]");
});

test("hyphenated-span family: a PLAIN (non-truncated) shaped id keeps the WHOLE-node-text span", () => {
  for (const [body, slice] of [["plain[X]", "plain[X]"], ["node_1((c))", "node_1((c))"], ['A["Q"]', 'A["Q"]']]) {
    const src = `graph TD\n${body}`;
    const n = findMermaidBlocks(src, true)[0].nodes[0];
    assert.equal(src.split("\n")[n.line].slice(n.startChar, n.endChar), slice, `${body}: whole-text span`);
  }
});

// ── v1.4 renders-it-but-warn families ─────────────────────────────────────────

const codesOf = (b) => [...new Set((b.warnings || []).map((w) => w.code))].sort();

// A block may be supported:true AND carry warnings (the yellow-lint). A clean
// canonical block carries an empty warnings array.
test("warnings channel: supported block carries an empty array on a clean parse", () => {
  const b = findMermaidBlocks("graph TD\nA[Start] --> B[End]", true)[0];
  assert.equal(b.supported, true);
  assert.deepEqual(b.warnings, []);
});

test("warnings channel: a fenced-block warning line is absolute in the document", () => {
  // A lowercase-reserved shaped node (`end[X]`) on the 5th line (0-based 4) of the
  // document. v1.6: `end[X]` is Mermaid-rejected → the block is supported:false and the
  // reserved-id warning's line is the ABSOLUTE document line. (`End[X]` would now be a
  // normal node — case-sensitive #1a — so this pins the exact lowercase token.)
  const src = "# Doc\n\n```mermaid\ngraph TD\nend[X]\n```";
  const b = findMermaidBlocks(src, false)[0];
  assert.equal(b.supported, false);
  const w = (b.warnings || []).find((x) => x.code === "reserved-id");
  assert.ok(w, "reserved-id warning present");
  assert.equal(w.line, 4, "warning line is the absolute document line of end[X]");
});

// v1.6 #1a — reserved-keyword node id matching is CASE-SENSITIVE: only the EXACT
// lowercase Mermaid tokens are reserved. A capitalized/mixed-case variant (`End[X]`,
// `STYLE[x]`, `Graph[x]`) is an ORDINARY node — REAL Mermaid renders it as a node, so
// the block is supported:true with the node present, NOT a reserved-id skip.
test("v1.6 #1a: a capitalized/mixed-case reserved-looking node id is an ordinary node (case-sensitive)", () => {
  for (const kw of ["End", "STYLE", "Graph", "ClassDef", "SUBGRAPH", "Direction"]) {
    const b = findMermaidBlocks(`graph TD\nA-->B\n${kw}[X]\nC-->D`, true)[0];
    assert.equal(b.supported, true, `${kw}[X]: ordinary node → supported:true`);
    assert.deepEqual(b.nodes.map((n) => n.id), [kw], `${kw}[X]: a normal node, NOT skipped`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"], `${kw}[X]: edges`);
    assert.deepEqual(codesOf(b), [], `${kw}[X]: no reserved-id warning (not reserved)`);
  }
  // the EXACT lowercase token IS reserved — Mermaid rejects it → supported:false.
  const low = findMermaidBlocks("graph TD\nA-->B\nstyle[X]\nC-->D", true)[0];
  assert.equal(low.supported, false, "style[X]: lowercase reserved → supported:false");
  assert.deepEqual(codesOf(low), ["reserved-id"]);
});

// B2 (v1.6) — a reserved keyword as a subgraph id is kept in the best-effort model +
// warned; an edge REFERENCING the reserved id is a Mermaid-REJECTS endpoint, so the
// block is supported:false (Mermaid Parse-errors `C --> graph`).
test("v1.6 B2: a reserved keyword subgraph id with a referencing edge is supported:false; model kept", () => {
  const b = findMermaidBlocks("graph TD\nsubgraph graph[Title]\n  C --> graph\nend", true)[0];
  assert.equal(b.supported, false, "the C-->graph reserved-endpoint edge → supported:false");
  assert.deepEqual(b.subgraphs.map((s) => ({ id: s.id, label: s.label })), [{ id: "graph", label: "Title" }]);
  assert.equal(b.edges.length, 0, "the C-->graph edge (reserved endpoint) is dropped");
  assert.deepEqual(codesOf(b), ["reserved-id", "reserved-id-subgraph"]);
});

// B3 — `&` fan-out/fan-in is SPLIT into the real pairwise edges + one advisory.
test("v1.4 B3: & fan-out/fan-in splits into the real pairwise edges, never block-fatal", () => {
  const cases = [
    ["A --> B & C", ["A->B", "A->C"]],
    ["A & B --> C", ["A->C", "B->C"]],
    ["A & B --> C & D", ["A->C", "A->D", "B->C", "B->D"]],
    ["A --> B & C --> D", ["A->B", "A->C", "B->D", "C->D"]],
  ];
  for (const [body, edges] of cases) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.equal(b.supported, true, `${body}: supported`);
    assert.equal(b.parseError, undefined, `${body}: no parseError`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), edges, `${body}: split edges`);
    assert.deepEqual(codesOf(b), ["fanout-split"], `${body}: one fanout-split advisory`);
  }
  // a reserved member in a fan-out drops only its edge (reserved-id) + still splits
  const r = findMermaidBlocks("graph TD\nA --> B & end", true)[0];
  assert.deepEqual(r.edges.map((e) => `${e.from}->${e.to}`), ["A->B"]);
  assert.deepEqual(codesOf(r), ["fanout-split", "reserved-id"]);
});

// B4 (v1.6 #3) — an UNQUOTED bracket char inside a label is a Mermaid-REJECTS form
// (oracle: `A[Order (Pending)]`, `A(read [x])` → Parse error; the v1.4 "keep it as
// content" behavior was over-lenient). The block is supported:false + an `invalid-label`
// warning; the best-effort node (with the bracket kept in the label, content-exclusive
// span intact) is still exposed for editing. A QUOTED label with brackets renders.
test("v1.6 B4: an unquoted bracket inside a label is supported:false; a quoted one renders", () => {
  const cases = [
    ["A[Order (Pending)]", "Order (Pending)", "[]"],
    ["A[Status {x}]", "Status {x}", "[]"],
    ["A(read [x])", "read [x]", "()"],
    ["A{check (x)}", "check (x)", "{}"],
    ["A[[Sub (x)]]", "Sub (x)", "[[]]"],
    ["A((Circle [x]))", "Circle [x]", "(())"],
    ["A{{Hex (x)}}", "Hex (x)", "{{}}"],
    ["A([Stadium {x}])", "Stadium {x}", "([])"],
  ];
  for (const [body, label, shape] of cases) {
    const src = `graph TD\n${body}`;
    const b = findMermaidBlocks(src, true)[0];
    assert.equal(b.supported, false, `${body}: unquoted bracket in label → supported:false`);
    const n = b.nodes[0];
    assert.equal(n.label, label, `${body}: best-effort node keeps the bracket in the label`);
    assert.equal(n.shape, shape, `${body}: shape`);
    // span-content invariant: the label span still slices to exactly the label
    assert.equal(src.split("\n")[n.line].slice(n.labelStart, n.labelEnd), label, `${body}: label span slices to content`);
    assert.deepEqual(codesOf(b), ["invalid-label"], `${body}: invalid-label warning`);
  }
  // a QUOTED label containing brackets RENDERS (supported:true, no warning).
  for (const [body, label] of [['A["Order (Pending)"]', "Order (Pending)"], ['A("read [x]")', "read [x]"]]) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.equal(b.supported, true, `${body}: quoted bracket label renders`);
    assert.equal(b.nodes[0].label, label, `${body}: label`);
    assert.deepEqual(codesOf(b), [], `${body}: no warning`);
  }
  // the ASYMMETRIC over-bracket guard is unchanged — these still hard-fail.
  for (const src of ["graph TD\nA[[[hello]]", "graph TD\nA((x)", "graph TD\nA{{{x}}", "graph TD\nA[[x]"]) {
    const b = findMermaidBlocks(src, true)[0];
    assert.equal(b.supported, false, `${src}: over-bracket still hard-fails`);
    assert.equal(b.nodes.length, 0, `${src}: no live node`);
  }
});

// C — advisory warnings on forms that already parse but are non-canonical.
test("v1.4 C: inline-dash edge labels carry the inline-dash-label advisory; pipe form does not", () => {
  for (const body of ["A -- text --> B", "A == text ==> B", "A -- text --- B", 'A -- "q" --> B']) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.equal(b.edges.length, 1, `${body}: one edge`);
    assert.deepEqual(codesOf(b), ["inline-dash-label"], `${body}: advisory`);
  }
  // canonical pipe + bare arrow carry NO advisory
  assert.deepEqual(codesOf(findMermaidBlocks("graph TD\nA -->|label| B", true)[0]), []);
  assert.deepEqual(codesOf(findMermaidBlocks("graph TD\nA --> B", true)[0]), []);
});

test("v1.4 C: a hyphenated id carries the non-canonical-id advisory (bare, shaped, endpoint)", () => {
  for (const body of ["send-email", "send-email[L]", "send-email --> B", "A --> recv-order"]) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.deepEqual(codesOf(b), ["non-canonical-id"], `${body}: non-canonical-id advisory`);
  }
  // a plain (non-hyphenated) id carries no advisory
  assert.deepEqual(codesOf(findMermaidBlocks("graph TD\nplain --> B", true)[0]), []);
});

test("a backtracked speculative path leaves NO spurious warning (model-attached, not a shared array)", () => {
  // `A -- a---b ---- B` exercises the inline-dash label path with a glued embedded link
  // run; the parser backtracks across several Link alternatives before committing on the
  // Mermaid-faithful split (A -[a]-> b, b -> B). Exactly ONE inline-dash-label advisory
  // must survive — not one per speculative attempt.
  const b = findMermaidBlocks("graph TD\nA -- a---b ---- B", true)[0];
  assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->b", "b->B"]);
  assert.deepEqual(codesOf(b), ["inline-dash-label"]);
  // and a clean canonical chain after a fan-out line keeps warnings scoped per block
  const b2 = findMermaidBlocks("graph TD\nA --> B & C\nD --> E", true)[0];
  assert.deepEqual(b2.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "A->C", "D->E"]);
  assert.deepEqual(codesOf(b2), ["fanout-split"]);
});

// A reserved-keyword SHAPED node as one segment of a `;` chain is recovered
// (dropped + reserved-id warned) so the surrounding chain edges survive — the same
// graceful skip the own-line form already does, never a whole-block hard-fail.
test("a reserved shaped node in a `;` chain is recovered block-locally; surrounding edges stay (supported:false)", () => {
  // v1.6 #3 — `end[X]` is a Mermaid-REJECTS form, so the block is supported:false; the
  // best-effort model still drops only the reserved segment and keeps the surrounding
  // chain edges (no whole-block data loss in the model).
  const b = findMermaidBlocks("graph TD\nA --> B; end[X]; C --> D\n", true)[0];
  assert.equal(b.supported, false, "reserved shaped chain segment → supported:false");
  assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"], "both on-contract edges survive in the model");
  assert.equal(b.nodes.length, 0, "the reserved shaped node is not emitted");
  assert.deepEqual(codesOf(b), ["reserved-id"], "the drop is advised");
  // it matches the own-line form exactly (same model, same advisory, same supported)
  const own = findMermaidBlocks("graph TD\nA --> B\nend[X]\nC --> D\n", true)[0];
  assert.equal(own.supported, false);
  assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), own.edges.map((e) => `${e.from}->${e.to}`));
  assert.deepEqual(codesOf(b), codesOf(own));
  // a non-`end` reserved keyword recovers in a chain too (also supported:false).
  const b2 = findMermaidBlocks("graph TD\nA --> B; style[X]; C --> D\n", true)[0];
  assert.equal(b2.supported, false, "non-end reserved shaped segment → supported:false");
  assert.deepEqual(b2.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"]);
});

// Several DISTINCT reserved ids on ONE line each emit their OWN reserved-id
// advisory — keying the dedup on (code|line) alone would collapse them to one and
// silently drop the rest. Same-id same-line re-warns are still suppressed.
test("multiple distinct reserved ids on one line each emit a reserved-id advisory", () => {
  const b = findMermaidBlocks("graph TD\nend & style --> B\nA --> C\n", true)[0];
  assert.equal(b.supported, false, "reserved endpoints → supported:false (v1.6 #3)");
  assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->C"], "only the on-contract edge survives in the model");
  const reserved = (b.warnings || []).filter((w) => w.code === "reserved-id");
  assert.equal(reserved.length, 2, "both `end` and `style` warn (distinct)");
  const ids = reserved.map((w) => /"([^"]+)"/.exec(w.message)[1]).sort();
  assert.deepEqual(ids, ["end", "style"], "one advisory per distinct reserved id");
  assert.deepEqual(codesOf(b), ["fanout-split", "reserved-id"], "code set");
  // no `_dedup` rider leaks into the public warning shape
  for (const w of b.warnings) {
    assert.deepEqual(Object.keys(w).sort(), ["code", "line", "message"], "public warning shape is clean");
  }
  // same reserved id twice on one line collapses to ONE advisory (backtracking-safe)
  const same = findMermaidBlocks("graph TD\nend & end --> B\n", true)[0];
  assert.equal((same.warnings || []).filter((w) => w.code === "reserved-id").length, 1, "same-id same-line warns once");
});

// A labeled inline edge whose OPEN shaft and CLOSE shaft differ in style is what
// Mermaid REJECTS — make it an honest parseError (supported:false), NEVER a silent
// phantom (`A -- label === B` used to mis-parse into A->label, label->B with no
// warning). Matched-shaft labeled edges keep parsing.
test("a mixed-shaft labeled inline edge hard-fails honestly (no silent phantom)", () => {
  const mixed = [
    "A -- label === B",   // dash open, thick close
    "A -- label ==> B",   // dash open, thick arrow close
    "A == label --- B",   // thick open, dash close
    "A == label --> B",   // thick open, dash arrow close
    "A -- label -.- B",   // dash open, dotted close
  ];
  for (const body of mixed) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.equal(b.supported, false, `${body}: mixed shaft is supported:false`);
    assert.ok(b.parseError, `${body}: carries a parseError`);
    assert.equal(b.nodes.length, 0, `${body}: no phantom node`);
    assert.equal(b.edges.length, 0, `${body}: no phantom edge`);
  }
  // MATCHED-shaft labeled edges still parse to ONE labeled edge.
  for (const body of ["A -- l --> B", "A == l ==> B", "A -- l --- B", "A == l === B"]) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.equal(b.supported, true, `${body}: matched shaft still parses`);
    assert.equal(b.edges.length, 1, `${body}: one edge`);
    assert.equal(b.edges[0].label, "l", `${body}: label`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B"], `${body}: endpoints`);
  }
  // plain (unlabeled) dash/thick/dotted edges are unaffected.
  for (const body of ["A --> B", "A ==> B", "A -.-> B", "A --- B", "A === B"]) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.equal(b.supported, true, `${body}: plain edge parses`);
    assert.equal(b.edges.length, 1, `${body}: one edge`);
  }
});

// rank1 — DOTTED inline-label `-. text .->` renders in real Mermaid as ONE labeled
// dotted edge; it must NOT hard-fail the whole block. Parallels the inline-dash arm:
// one labeled edge + an `inline-dot-label` advisory, surroundings intact.
test("inline-dot edge label `-. text .->` is one labeled dotted edge + inline-dot-label advisory", () => {
  for (const body of [
    "A -. text .-> B",          // dotted ARROW close
    "A -. text .- B",           // dotted HEAD-LESS (open) close
    "A -. text ..-> B",         // longer dotted close
    "A -. a-b .-> B",           // internal hyphen preserved
    'A -. "q lbl" .-> B',       // double-quoted label, quotes stripped
    "A -. 'q lbl' .-> B",       // single-quoted label
  ]) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.equal(b.supported, true, `${body}: parses (no whole-block hard-fail)`);
    assert.equal(b.parseError, undefined, `${body}: no parseError`);
    assert.equal(b.edges.length, 1, `${body}: ONE labeled edge`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B"], `${body}: endpoints A->B`);
    assert.deepEqual(codesOf(b), ["inline-dot-label"], `${body}: inline-dot-label advisory`);
  }
  // quoted-label content is exactly the unquoted text
  const q = findMermaidBlocks('graph TD\nA -. "q lbl" .-> B', true)[0];
  assert.equal(q.edges[0].label, "q lbl");
  // SURROUNDINGS survive: a dotted-inline edge between two plain edges keeps all three
  const surr = findMermaidBlocks("graph TD\nA --> B\nB -. error .-> C\nC --> D", true)[0];
  assert.equal(surr.supported, true, "surrounding block survives");
  assert.deepEqual(surr.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "B->C", "C->D"]);
  assert.equal(surr.edges.find((e) => e.from === "B" && e.to === "C").label, "error", "labeled edge carries the label");
  assert.deepEqual(codesOf(surr), ["inline-dot-label"], "exactly the one advisory");
  // shaped endpoints emit their nodes plus the one labeled edge
  const shaped = findMermaidBlocks("graph TD\nA[S] -. go .-> B[E]", true)[0];
  assert.deepEqual(shaped.nodes.map((n) => n.id), ["A", "B"]);
  assert.equal(shaped.edges.length, 1);
  assert.equal(shaped.edges[0].label, "go");
  // the canonical dotted pipe form `-.->|label|` is NOT an inline-dot label (no advisory)
  const pipe = findMermaidBlocks("graph TD\nA -.->|go| B", true)[0];
  assert.equal(pipe.edges[0].label, "go");
  assert.deepEqual(codesOf(pipe), [], "pipe form is canonical, no advisory");
});

// rank1 REGRESSION PIN — a 3+-shaft opener does NOT open an inline label in real
// Mermaid: `A --- text --> B` is the genuine node `text` with two bare edges
// (A->text, text->B), and `A === text ===> B` likewise. This MATCHES real Mermaid;
// the dotted-inline fix must NOT have been over-generalized into a 3+-shaft inline
// label arm (that would DIVERGE). Pin both the dash and thick forms to the
// two-bare-edge model so a future round cannot "re-fix" them into a bug.
test("rank1 regression: a 3+-shaft opener is two bare edges (genuine middle node), NOT an inline label", () => {
  const dash = findMermaidBlocks("graph TD\nA --- text --> B", true)[0];
  assert.equal(dash.supported, true);
  assert.deepEqual(dash.edges.map((e) => `${e.from}->${e.to}`), ["A->text", "text->B"], "dash 3-shaft → two bare edges");
  assert.equal(dash.edges.every((e) => e.label === undefined), true, "no inline label fabricated");
  assert.deepEqual(codesOf(dash), [], "no inline-label advisory on the 3-shaft form");

  const thick = findMermaidBlocks("graph TD\nA === text ===> B", true)[0];
  assert.equal(thick.supported, true);
  assert.deepEqual(thick.edges.map((e) => `${e.from}->${e.to}`), ["A->text", "text->B"], "thick 3-shaft → two bare edges");
  assert.equal(thick.edges.every((e) => e.label === undefined), true, "no inline label fabricated");
  assert.deepEqual(codesOf(thick), [], "no inline-label advisory on the 3-shaft thick form");
});

// rank3 — the same-line warning-dedup CLASS. Every same-line multi-warning callsite
// (id-truncation in an edge chain, in a `;` chain, and reserved-keyword skips in a
// `;` chain) must surface ONE warning PER DISTINCT token, while a SAME-token repeat
// (incl. PEG-backtracking re-emits) collapses to one. This is a warning-COUNT test:
// it asserts EXACTLY N warnings, which the corpus harness (code-SET only) can't pin.
test("rank3: same-line warnings dedupe per DISTINCT token, not per (code,line)", () => {
  const countOf = (b, code) => (b.warnings || []).filter((w) => w.code === code).length;

  // two DISTINCT hyphenated ids on one edge line → TWO non-canonical-id warnings
  const twoEdge = findMermaidBlocks("graph TD\nfoo-bar --> baz-qux", true)[0];
  assert.deepEqual(twoEdge.edges.map((e) => `${e.from}->${e.to}`), ["foo-bar->baz-qux"]);
  assert.equal(countOf(twoEdge, "non-canonical-id"), 2, "foo-bar + baz-qux each warn");

  // SAME full id on one line → ONE warning (foo-bar --> foo-qux: both are `foo-bar` / `foo-qux` but only foo-bar repeats)
  // Actually foo-bar and foo-qux are distinct ids, so both warn. Use foo-bar --> foo-bar:
  const sameEdge = findMermaidBlocks("graph TD\nfoo-bar --> foo-bar", true)[0];
  assert.equal(countOf(sameEdge, "non-canonical-id"), 1, "same full id collapses to one");

  // a 3-link chain with three distinct hyphenated ids → THREE warnings
  const threeChain = findMermaidBlocks("graph TD\nfoo-bar --> baz-qux --> qux-zap", true)[0];
  assert.equal(countOf(threeChain, "non-canonical-id"), 3, "three distinct hyphenated ids → three warnings");

  // two hyphenated bare nodes in a `;` chain → TWO warnings
  const twoSemi = findMermaidBlocks("graph TD\nfoo-bar; baz-qux", true)[0];
  assert.equal(countOf(twoSemi, "non-canonical-id"), 2, "two distinct NodeStmt hyphenated ids in a ; chain");
  // same full id in a `;` chain → ONE
  const sameSemi = findMermaidBlocks("graph TD\nfoo-bar; foo-bar", true)[0];
  assert.equal(countOf(sameSemi, "non-canonical-id"), 1, "same full id in a ; chain collapses");

  // two DISTINCT reserved keywords skipped in a `;` chain → TWO reserved-id warnings
  const twoReserved = findMermaidBlocks("graph TD\nend[X]; style[Y]", true)[0];
  assert.equal(countOf(twoReserved, "reserved-id"), 2, "end + style each warn");
  // the SAME reserved keyword twice → ONE
  const sameReserved = findMermaidBlocks("graph TD\nend[X]; end[Y]", true)[0];
  assert.equal(countOf(sameReserved, "reserved-id"), 1, "same reserved keyword collapses");

  // the `_dedup` rider must NOT leak into the public warning shape on ANY of these
  for (const b of [twoEdge, twoSemi, twoReserved]) {
    for (const w of b.warnings) {
      assert.deepEqual(Object.keys(w).sort(), ["code", "line", "message"], "clean public warning shape (no _dedup)");
    }
  }
});

// rank4 — `titleStart`/`titleEnd` are ALWAYS present on a subgraph (cleaner option),
// upholding `slice(titleStart, titleEnd) === label` for every header form, so a
// consumer can slice unconditionally without an unguarded slice returning full-line
// garbage on an id-only or bare header.
test("rank4: subgraph titleStart/titleEnd are always present and slice to the label", () => {
  const cases = [
    { src: "subgraph S1[My Title]\nA --> B\nend", label: "My Title" },  // id + title
    { src: "subgraph S1\nA --> B\nend", label: "S1" },                   // id, NO title
    { src: "subgraph My Group\nA --> B\nend", label: "My Group" },       // free title, no id
    { src: 'subgraph "Quoted"\nA --> B\nend', label: "Quoted" },         // quoted title-only
    { src: "subgraph\nA --> B\nend", label: "" },                        // bare: no id, no title
  ];
  for (const { src, label } of cases) {
    const text = `graph TD\n${src}`;
    const lines = text.split("\n");
    const sg = findMermaidBlocks(text, true)[0].subgraphs[0];
    assert.equal(typeof sg.titleStart, "number", `${src}: titleStart present`);
    assert.equal(typeof sg.titleEnd, "number", `${src}: titleEnd present`);
    assert.ok(sg.titleStart >= 0 && sg.titleEnd >= sg.titleStart, `${src}: span non-negative + ordered`);
    assert.ok(sg.titleEnd <= lines[sg.line].length, `${src}: span in-range`);
    assert.equal(lines[sg.line].slice(sg.titleStart, sg.titleEnd), label, `${src}: slice === label ${JSON.stringify(label)}`);
    assert.equal(sg.label, label, `${src}: label`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Arrow-operator family completeness + ADDITIVE edge metadata.
//
// Every arrow form is variadic in shaft length; head/stroke/bidirectional/length
// mirror REAL Mermaid v11.15.0's FlowDB.getEdges() (`type`/`stroke`/`length`).
// The ORACLE TABLE below is the regression pin — each row was read directly from
// Mermaid's own grammar parser (not memory). A row asserts: the block parses
// (supported:true), one edge, and its head/stroke/bidirectional/length.
//
// Drift guard: if a future grammar change perturbs any cell, this fails loudly.
// ─────────────────────────────────────────────────────────────────────────────
test("arrow metadata matches the real-Mermaid oracle table (head/stroke/bidir/length)", () => {
  // [op, head, stroke, bidirectional, length]  — op placed between C and D.
  const table = [
    // forward solid (variadic)
    ["-->",   "arrow",  "solid",     false, 1],
    ["--->",  "arrow",  "solid",     false, 2],
    ["---->", "arrow",  "solid",     false, 3],
    ["---",   "open",   "solid",     false, 1],
    ["----",  "open",   "solid",     false, 2],
    // solid tail x/o (variadic)
    ["--x",   "cross",  "solid",     false, 1],
    ["---x",  "cross",  "solid",     false, 2],
    ["----x", "cross",  "solid",     false, 3],
    ["--o",   "circle", "solid",     false, 1],
    ["---o",  "circle", "solid",     false, 2],
    ["----o", "circle", "solid",     false, 3],
    // thick (variadic)
    ["==>",   "arrow",  "thick",     false, 1],
    ["===>",  "arrow",  "thick",     false, 2],
    ["====>", "arrow",  "thick",     false, 3],
    ["===",   "open",   "thick",     false, 1],
    ["====",  "open",   "thick",     false, 2],
    ["==x",   "cross",  "thick",     false, 1],
    ["==o",   "circle", "thick",     false, 1],
    // dotted (variadic)
    ["-.->",  "arrow",  "dotted",    false, 1],
    ["-..->", "arrow",  "dotted",    false, 2],
    ["-.-",   "open",   "dotted",    false, 1],
    ["-.-x",  "cross",  "dotted",    false, 1],
    ["-.-o",  "circle", "dotted",    false, 1],
    // invisible (variadic; >=3 tildes)
    ["~~~",   "open",   "invisible", false, 1],
    ["~~~~",  "open",   "invisible", false, 2],
    // bidirectional (head on BOTH ends; variadic)
    ["<-->",  "arrow",  "solid",     true,  1],
    ["<--->", "arrow",  "solid",     true,  2],
    ["<---->","arrow",  "solid",     true,  3],
    ["<==>",  "arrow",  "thick",     true,  1],
    ["<-.->", "arrow",  "dotted",    true,  1],
    ["o--o",  "circle", "solid",     true,  1],
    ["o---o", "circle", "solid",     true,  2],
    ["x--x",  "cross",  "solid",     true,  1],
    ["x==x",  "cross",  "thick",     true,  1],
    ["o==o",  "circle", "thick",     true,  1],
    ["x-.-x", "cross",  "dotted",    true,  1],
    ["o-.-o", "circle", "dotted",    true,  1],
    // reverse-only (left `<` indicator, no `>` on the right → arrow_open; oracle:
    // start=left/end=right, NO from/to swap — C is from, D is to, matching Mermaid's
    // data model; the `<` is a visual indicator only)
    ["<---",  "open",   "solid",     false, 2],
    ["<----", "open",   "solid",     false, 3],
    // leading head (decorative per oracle → arrow_point; length shifted +1)
    ["o-->",  "arrow",  "solid",     false, 2],
    ["x-->",  "arrow",  "solid",     false, 2],
    ["o--->", "arrow",  "solid",     false, 3],
  ];
  for (const [op, head, stroke, bidirectional, length] of table) {
    const b = findMermaidBlocks(`graph TD\nC ${op} D`, true)[0];
    assert.equal(b.supported, true, `${op}: must parse (renders in Mermaid)`);
    assert.equal(b.edges.length, 1, `${op}: exactly one edge`);
    const e = b.edges[0];
    assert.equal(e.head, head, `${op}: head`);
    assert.equal(e.stroke, stroke, `${op}: stroke`);
    assert.equal(e.bidirectional, bidirectional, `${op}: bidirectional`);
    assert.equal(e.length, length, `${op}: length`);
    // oracle: ALL forms are C->D (left-node is from, right-node is to).
    // The `<` prefix is a visual indicator only — Mermaid's data model preserves
    // left-to-right order for reverse-only arrows (confirmed oracle-pinned v11.15.0).
    assert.equal(e.from, "C", `${op}: from`);
    assert.equal(e.to, "D", `${op}: to`);
  }
});

// MUST-PARSE in-contract shaft-variants carry NO warning (a length-variant is the
// same edge as its canonical form). `<--->`=`<-->`, `o--o`/`x--x`, `--x`/`--o`.
test("must-parse arrow shaft-variants parse cleanly with NO warning", () => {
  for (const op of ["<-->", "<--->", "<---->", "o--o", "x--x", "--x", "--o", "<==>"]) {
    const b = findMermaidBlocks(`graph TD\nA-->B\nC ${op} D\nE-->F`, true)[0];
    assert.equal(b.supported, true, `${op}: parses`);
    assert.equal(b.edges.length, 3, `${op}: all 3 edges present (block survives)`);
    assert.equal((b.warnings || []).length, 0, `${op}: no warning (must-parse, in-contract)\n  got ${JSON.stringify(b.warnings)}`);
  }
});

// WARN-best-effort renders forms parse + attach a `non-canonical-arrow` advisory:
// leading head (`o-->`/`x-->`), multi-shaft x/o (`---x`/`---o`/`----x`), invisible.
test("warn-best-effort arrow forms parse + a non-canonical-arrow advisory", () => {
  for (const op of ["o-->", "x-->", "o--->", "---x", "---o", "----x", "~~~", "~~~~"]) {
    const b = findMermaidBlocks(`graph TD\nA-->B\nC ${op} D\nE-->F`, true)[0];
    assert.equal(b.supported, true, `${op}: parses (renders in Mermaid)`);
    assert.equal(b.edges.length, 3, `${op}: surrounding edges survive`);
    assert.ok((b.warnings || []).some((w) => w.code === "non-canonical-arrow"), `${op}: non-canonical-arrow advisory present\n  got ${JSON.stringify((b.warnings || []).map((w) => w.code))}`);
  }
});

// FIX C — the STRUCTURAL BACKSTOP: a recognized-but-not-modeled / Mermaid-rejected
// arrow is dropped BLOCK-LOCALLY with an `unsupported-arrow` advisory; the block
// stays supported:true and EVERY surrounding valid edge survives. After this, no
// arrow form can EVER discard the whole block (the maximal silent-loss class).
test("unsupported-arrow (v1.6): a Mermaid-REJECTED arrow → supported:false; a renders-but-unmodeled arrow → supported:true; both keep surroundings", () => {
  // v1.6 #3 RENDERS-vs-REJECTS split. Mermaid-REJECTED forms (`-->o`/`-->x`/`==>o`/
  // `-.->x` → Parse error) are supported:false; the best-effort model still drops only
  // the bad edge and keeps the surrounding A->B / E->F. The block is never whole-block
  // empty (the maximal silent-loss class is still killed — surroundings survive).
  for (const op of ["-->o", "-->x", "==>o", "-.->x"]) {
    const b = findMermaidBlocks(`graph TD\nA-->B\nC ${op} D\nE-->F`, true)[0];
    assert.equal(b.supported, false, `${op}: Mermaid-rejects → supported:false`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "E->F"], `${op}: surrounding edges kept, bad edge skipped`);
    assert.ok((b.warnings || []).some((w) => w.code === "unsupported-arrow"), `${op}: unsupported-arrow advisory`);
  }
  // Quirky leading-head forms that REAL Mermaid RENDERS (`o--x`, `x--o`, `o==>`,
  // `o---`, `x==o` → render as an edge C->D). Per the contract "renders-it → warn-don't-deny":
  // the C->D edge IS EMITTED (not dropped) + an `unsupported-arrow` advisory; supported:true.
  // The surrounding A->B / E->F survive too (ALL three edges present).
  for (const op of ["o--x", "x--o", "o==>", "o---", "x==o"]) {
    const b = findMermaidBlocks(`graph TD\nA-->B\nC ${op} D\nE-->F`, true)[0];
    assert.equal(b.supported, true, `${op}: renders in Mermaid → supported:true`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D", "E->F"], `${op}: C->D edge emitted (renders); surroundings kept`);
    assert.ok((b.warnings || []).some((w) => w.code === "unsupported-arrow"), `${op}: unsupported-arrow advisory`);
  }
});

// Node ids that START with `o`/`x` glued to an arrow must NOT be eaten by the
// circle/cross arrow rules — `a-->x2`, `a-->o2`, bare `a-->x` are normal edges to
// a node (oracle: Mermaid renders `a → x2`), not the rejected `-->x` form.
test("a node id starting with o/x glued to an arrow stays a node, not an arrow head", () => {
  const cases = [
    ["graph TD\na-->x2", "a", "x2"],
    ["graph TD\na-->o2", "a", "o2"],
    ["graph TD\na-->xyz", "a", "xyz"],
    ["graph TD\nx1-->x2", "x1", "x2"],
    ["graph TD\nox --> oy", "ox", "oy"],
    ["graph TD\na-->x", "a", "x"],
  ];
  for (const [src, from, to] of cases) {
    const b = findMermaidBlocks(src, true)[0];
    assert.equal(b.supported, true, `${src}: parses`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), [`${from}->${to}`], `${src}: edge ${from}->${to}`);
    assert.equal((b.warnings || []).length, 0, `${src}: no spurious warning\n  got ${JSON.stringify(b.warnings)}`);
  }
});

// ADDITIVE metadata must not break the long-standing edge shape: from/to/label and
// the existing position fields are unchanged; the new fields are simply present.
test("edge metadata is ADDITIVE: from/to/label/positions intact alongside new fields", () => {
  const b = findMermaidBlocks("graph TD\nA -->|yes| B", true)[0];
  const e = b.edges[0];
  assert.equal(e.from, "A");
  assert.equal(e.to, "B");
  assert.equal(e.label, "yes");
  assert.equal(typeof e.line, "number");
  assert.equal(typeof e.startChar, "number");
  assert.ok(e.endChar > e.startChar, "real span preserved");
  // new additive fields present
  assert.equal(e.head, "arrow");
  assert.equal(e.stroke, "solid");
  assert.equal(e.bidirectional, false);
  assert.equal(e.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Arm-enumerated regression pins — hyphenated ids (the contract full-id fix)
// ─────────────────────────────────────────────────────────────────────────────

// HYPHEN cross-product: {bare, shaped × shape-family, edge-endpoint × src/dst,
// chain} × {single-hyphen, multi-hyphen}. Oracle: full id in model, non-canonical-id
// warning, NO truncation.
test("hyphen full-id: bare nodes read the full hyphenated id + non-canonical-id warning", () => {
  // Bare single-hyphen ids — each reads the full id
  for (const [body, wantId] of [
    ["receive-order",  "receive-order"],
    ["ship-order",     "ship-order"],
    ["a-b",           "a-b"],
    ["a-b-c",         "a-b-c"],
    ["a-b-c-d",       "a-b-c-d"],
  ]) {
    const src = `graph TD\n${body}`;
    const b = findMermaidBlocks(src, true)[0];
    assert.equal(b.supported, true, `${body}: supported`);
    assert.equal(b.nodes.length, 1, `${body}: one node`);
    assert.equal(b.nodes[0].id, wantId, `${body}: full id`);
    assert.equal(b.nodes[0].label, wantId, `${body}: label = id for bare node`);
    // span covers the full id text
    const line = src.split("\n")[b.nodes[0].line];
    assert.equal(line.slice(b.nodes[0].startChar, b.nodes[0].endChar), wantId, `${body}: span slices to full id`);
    assert.deepEqual(codesOf(b), ["non-canonical-id"], `${body}: non-canonical-id advisory`);
  }
});

test("hyphen full-id: shaped nodes read the full id; span covers whole declaration", () => {
  // Cross-product: shape-family × single/multi hyphen
  const cases = [
    // [body, wantId, wantLabel]
    ["send-email[Label]",   "send-email",  "Label"],
    ["send-email(R)",       "send-email",  "R"],
    ["send-email{D}",       "send-email",  "D"],
    ["send-email([S])",     "send-email",  "S"],
    ["send-email[[Sub]]",   "send-email",  "Sub"],
    ["send-email[(Store)]", "send-email",  "Store"],
    ["send-email((Rnd))",   "send-email",  "Rnd"],
    ["send-email{{Hex}}",   "send-email",  "Hex"],
    ["send-email>Asym]",    "send-email",  "Asym"],
    ["a-b-c-d[Z]",          "a-b-c-d",    "Z"],
  ];
  for (const [body, wantId, wantLabel] of cases) {
    const src = `graph TD\n${body}`;
    const b = findMermaidBlocks(src, true)[0];
    assert.equal(b.supported, true, `${body}: supported`);
    assert.equal(b.nodes[0].id, wantId, `${body}: full id`);
    assert.equal(b.nodes[0].label, wantLabel, `${body}: label from shape`);
    // node span covers the whole declaration (id + shape)
    const line = src.split("\n")[b.nodes[0].line];
    assert.equal(line.slice(b.nodes[0].startChar, b.nodes[0].endChar), body, `${body}: node span = whole decl`);
    // label span slices to label content exactly
    assert.equal(line.slice(b.nodes[0].labelStart, b.nodes[0].labelEnd), wantLabel, `${body}: label span`);
    assert.deepEqual(codesOf(b), ["non-canonical-id"], `${body}: non-canonical-id advisory`);
  }
});

test("hyphen full-id: edge endpoints read the full hyphenated id; edges carry full ids", () => {
  // Source, destination, and both-hyphenated
  const cases = [
    ["receive-order --> B",       "receive-order", "B"],
    ["A --> ship-order",          "A",             "ship-order"],
    ["receive-order --> ship-order", "receive-order", "ship-order"],
    ["a-b-c --> d-e-f",          "a-b-c",         "d-e-f"],
  ];
  for (const [body, wantFrom, wantTo] of cases) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.equal(b.supported, true, `${body}: supported`);
    assert.equal(b.edges.length, 1, `${body}: one edge`);
    assert.equal(b.edges[0].from, wantFrom, `${body}: from`);
    assert.equal(b.edges[0].to, wantTo, `${body}: to`);
    // non-canonical-id warning present iff any id is hyphenated
    const hasHyphenSrc = wantFrom.includes("-");
    const hasHyphenDst = wantTo.includes("-");
    if (hasHyphenSrc || hasHyphenDst) {
      assert.ok(codesOf(b).includes("non-canonical-id"), `${body}: non-canonical-id advisory present`);
    } else {
      assert.deepEqual(codesOf(b), [], `${body}: no advisory for plain ids`);
    }
  }
});

test("hyphen full-id: shaped hyphenated endpoint in edge — node emitted with full id", () => {
  // send-email[L] --> B: node send-email emitted, edge send-email->B
  const src = "graph TD\nsend-email[L] --> B";
  const b = findMermaidBlocks(src, true)[0];
  assert.equal(b.supported, true);
  assert.equal(b.nodes.length, 1);
  assert.equal(b.nodes[0].id, "send-email");
  assert.equal(b.edges.length, 1);
  assert.equal(b.edges[0].from, "send-email");
  assert.equal(b.edges[0].to, "B");
  // span covers send-email[L]
  const line = src.split("\n")[b.nodes[0].line];
  assert.equal(line.slice(b.nodes[0].startChar, b.nodes[0].endChar), "send-email[L]");
});

test("hyphen full-id: plain (non-hyphenated) ids carry NO non-canonical-id warning", () => {
  // Verify the warning fires ONLY on hyphenated ids
  for (const body of ["order_ship --> confirm", "A --> B", "process[X]", "node_1 --> node_2"]) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.deepEqual(codesOf(b), [], `${body}: no non-canonical-id for plain ids`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Arm-enumerated regression pins — reverse arrow direction (the contract no-swap fix)
// ─────────────────────────────────────────────────────────────────────────────

// REVERSE cross-product: {solid, thick, dotted} × {shaft-lengths 3..5} × direction.
// Oracle: from=left-node, to=right-node (no swap). The `<` is a visual indicator only.
test("reverse arrow direction: solid <---+ keeps left-to-right order (from=left, to=right)", () => {
  // Variable shaft lengths
  for (const [op, wantLen] of [["<---", 2], ["<----", 3], ["<-----", 4]]) {
    const b = findMermaidBlocks(`graph TD\nC ${op} D`, true)[0];
    assert.equal(b.supported, true, `${op}: supported`);
    assert.equal(b.edges.length, 1, `${op}: one edge`);
    assert.equal(b.edges[0].from, "C", `${op}: from=C (left node, no swap)`);
    assert.equal(b.edges[0].to, "D", `${op}: to=D (right node, no swap)`);
    assert.equal(b.edges[0].head, "open", `${op}: head=open (no arrowhead)`);
    assert.equal(b.edges[0].stroke, "solid", `${op}: stroke=solid`);
    assert.equal(b.edges[0].length, wantLen, `${op}: length=${wantLen}`);
    assert.deepEqual(codesOf(b), [], `${op}: no warning`);
  }
});

test("reverse arrow direction: thick <===+ keeps left-to-right order; stroke=solid (Mermaid normalizes)", () => {
  // Mermaid reports stroke=normal (our 'solid') for <=== — oracle-confirmed
  for (const [op, wantLen] of [["<===", 2], ["<====", 3], ["<=====", 4]]) {
    const b = findMermaidBlocks(`graph TD\nG ${op} H`, true)[0];
    assert.equal(b.supported, true, `${op}: supported`);
    assert.equal(b.edges.length, 1, `${op}: one edge`);
    assert.equal(b.edges[0].from, "G", `${op}: from=G (no swap)`);
    assert.equal(b.edges[0].to, "H", `${op}: to=H (no swap)`);
    assert.equal(b.edges[0].head, "open", `${op}: head=open`);
    assert.equal(b.edges[0].stroke, "solid", `${op}: stroke=solid (Mermaid normalizes thick reverse to normal)`);
    assert.equal(b.edges[0].length, wantLen, `${op}: length=${wantLen}`);
    assert.deepEqual(codesOf(b), [], `${op}: no warning`);
  }
});

test("reverse arrow direction: dotted <-.-+ keeps left-to-right order; stroke=dotted", () => {
  for (const [op, wantLen] of [["<-.-", 1], ["<-..-", 2], ["<-...-", 3]]) {
    const b = findMermaidBlocks(`graph TD\nM ${op} N`, true)[0];
    assert.equal(b.supported, true, `${op}: supported`);
    assert.equal(b.edges.length, 1, `${op}: one edge`);
    assert.equal(b.edges[0].from, "M", `${op}: from=M (no swap)`);
    assert.equal(b.edges[0].to, "N", `${op}: to=N (no swap)`);
    assert.equal(b.edges[0].head, "open", `${op}: head=open`);
    assert.equal(b.edges[0].stroke, "dotted", `${op}: stroke=dotted`);
    assert.equal(b.edges[0].length, wantLen, `${op}: length=${wantLen}`);
    assert.deepEqual(codesOf(b), [], `${op}: no warning`);
  }
});

test("reverse arrow direction: shaped endpoints — nodes emitted, direction preserved", () => {
  // A[Start] <--- B[End]: from=A, to=B, both nodes emitted
  const b = findMermaidBlocks("graph TD\nA[Start] <--- B[End]", true)[0];
  assert.equal(b.supported, true);
  assert.equal(b.edges[0].from, "A");
  assert.equal(b.edges[0].to, "B");
  assert.deepEqual(b.nodes.map((n) => n.id), ["A", "B"]);
  assert.deepEqual(codesOf(b), []);
  // with thick
  const b2 = findMermaidBlocks("graph TD\nX[P] <=== Y[Q]", true)[0];
  assert.equal(b2.edges[0].from, "X");
  assert.equal(b2.edges[0].to, "Y");
});

test("reverse arrow direction: chain context — surrounding edges and direction all correct", () => {
  // A block mixing forward + reverse arrows — surroundings unaffected
  const b = findMermaidBlocks("graph TD\nA-->B\nC <--- D\nE-->F", true)[0];
  assert.equal(b.supported, true);
  assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D", "E->F"]);
  // all three edges: no spurious direction swap
  assert.equal(b.edges[1].from, "C");
  assert.equal(b.edges[1].to, "D");
});

test("reverse arrow direction: hyphenated ids in reverse arrow — full ids, no swap", () => {
  // receive-order <--- ship-order → from=receive-order, to=ship-order
  const b = findMermaidBlocks("graph TD\nreceive-order <--- ship-order", true)[0];
  assert.equal(b.supported, true);
  assert.equal(b.edges[0].from, "receive-order");
  assert.equal(b.edges[0].to, "ship-order");
  assert.ok(codesOf(b).includes("non-canonical-id"), "non-canonical-id for hyphenated ids");
});

// ─────────────────────────────────────────────────────────────────────────────
// Arm-enumerated regression pins — indented fence detection (CommonMark the contract.4)
// ─────────────────────────────────────────────────────────────────────────────
//
// CommonMark: a fenced code block opener indented ≥4 columns (or 1 tab, which
// equals 4) is NOT a fence — it is an indented code block, rendered as literal
// text. VS Code's markdown-it engine follows this rule exactly (empirically
// verified: 0-3 spaces → fence/mermaid, 4 spaces or tab → code_block).
// A block mis-detected as a live Mermaid diagram when it renders as literal text
// is a write-back corruption risk: the sidebar would offer rename/relabel and
// WorkspaceEdit would silently mutate prose the user sees as a code listing.
//
// Cross-product: {indent 0..4+, tab} × {backtick, tilde} × {with/without content}.

test("indented fence: 4-space indent is NOT a live Mermaid block (CommonMark literal)", () => {
  // 4-space indent → CommonMark indented code block (literal text); 0 live blocks.
  assert.equal(findMermaidBlocks("    ```mermaid\n    graph TD\n    A-->B\n    ```", false).length, 0, "4-space: 0 blocks");
  assert.equal(findMermaidBlocks("    ~~~mermaid\n    graph TD\n    A-->B\n    ~~~", false).length, 0, "4-space tilde: 0 blocks");
  // 5-space and 8-space also produce 0 blocks
  assert.equal(findMermaidBlocks("     ```mermaid\n     graph TD\n     A-->B\n     ```", false).length, 0, "5-space: 0 blocks");
  assert.equal(findMermaidBlocks("        ```mermaid\n        graph TD\n        A-->B\n        ```", false).length, 0, "8-space: 0 blocks");
});

test("indented fence: tab-indent is NOT a live Mermaid block (tab = 4 columns)", () => {
  // A leading tab equals 4 visual columns → same as 4-space; no live block.
  assert.equal(findMermaidBlocks("\t```mermaid\n\tgraph TD\n\tA-->B\n\t```", false).length, 0, "tab: 0 blocks");
  assert.equal(findMermaidBlocks("\t~~~mermaid\n\tgraph TD\n\tA-->B\n\t~~~", false).length, 0, "tab tilde: 0 blocks");
});

test("indented fence: indents 0, 1, 2, 3 ARE live Mermaid blocks", () => {
  // These are valid fence openers per CommonMark; the block renders as a diagram.
  for (const [name, prefix] of [["0", ""], ["1", " "], ["2", "  "], ["3", "   "]]) {
    const src = `${prefix}\`\`\`mermaid\ngraph TD\nA-->B\n${prefix}\`\`\``;
    const blocks = findMermaidBlocks(src, false);
    assert.equal(blocks.length, 1, `indent-${name}: 1 live block`);
    assert.equal(blocks[0].supported, true, `indent-${name}: supported:true`);
    assert.deepEqual(blocks[0].edges.map((e) => `${e.from}->${e.to}`), ["A->B"], `indent-${name}: edge A->B`);
  }
  // tilde fence, same indent range
  for (const [name, prefix] of [["0", ""], ["1", " "], ["2", "  "], ["3", "   "]]) {
    const src = `${prefix}~~~mermaid\ngraph TD\nA-->B\n${prefix}~~~`;
    assert.equal(findMermaidBlocks(src, false).length, 1, `tilde indent-${name}: 1 live block`);
  }
});

test("indented fence: a 4-space-indented opener in a multi-block doc is skipped; adjacent real fences survive", () => {
  // A 4-space-indented fence is literal; a real unindented fence before/after it parses normally.
  const src = "```mermaid\ngraph TD\nA-->B\n```\n\n    ```mermaid\n    graph TD\n    C-->D\n    ```\n\n```mermaid\ngraph TD\nE-->F\n```";
  const blocks = findMermaidBlocks(src, false);
  // Only the two real (0-indent) fences produce live blocks; the 4-space one is literal.
  assert.equal(blocks.length, 2, "2 live blocks (the 4-space fence is literal)");
  assert.deepEqual(blocks[0].edges.map((e) => `${e.from}->${e.to}`), ["A->B"]);
  assert.deepEqual(blocks[1].edges.map((e) => `${e.from}->${e.to}`), ["E->F"]);
});

test("indented fence: closing fence also respects the 0-3-column cap (CommonMark close rule)", () => {
  // A 4-space-indented closing fence is NOT a real close; the block is unterminated → 0 blocks.
  const src = "```mermaid\ngraph TD\nA-->B\n    ```";
  assert.equal(findMermaidBlocks(src, false).length, 0, "4-space close is not a real close → unterminated → 0 blocks");
  // A 3-space close IS valid.
  const src3 = "```mermaid\ngraph TD\nA-->B\n   ```";
  const b3 = findMermaidBlocks(src3, false);
  assert.equal(b3.length, 1, "3-space close is valid → 1 block");
  assert.equal(b3[0].supported, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Arm-enumerated regression pins — FIX-C catch-all forms emit edge + advisory
// ─────────────────────────────────────────────────────────────────────────────
//
// These are LEADING circle/cross head (`o`/`x`) forms on various shafts whose
// trailing combination is not one of the cleanly-modeled arms. Oracle: ALL of
// them RENDER in real Mermaid v11 as a plain A->B edge. Per the contract "renders-it →
// warn-don't-deny": the edge MUST be emitted (never silently dropped) — a drop
// is the the contract-prohibited "silently drop an on-contract edge" class.
//
// Cross-product: {o, x} × {solid-headless 3..5, solid-cross-head, solid-circle-head,
//                           thick-arrow-head, thick-open 3..4, thick-cross-head,
//                           dotted-open 1..2, dotted-cross-head}.
// Each arm: supported:true, A->B in edges, unsupported-arrow in warnings.

test("FIX-C renders family: each leading-o/x form emits the A->B edge + unsupported-arrow advisory", () => {
  // These all RENDER as C->D in real Mermaid (oracle-verified); emit the edge + warn.
  const renders = [
    // {o|x} + solid head-less shaft (3+ dashes, no `>`)
    "o---", "o----", "o-----",
    "x---", "x----",
    // {o|x} + solid cross/circle head (trailing x/o, not the same as source)
    "o--x",   // source=o, trail=x  → RENDERS C->D
    "x--o",   // source=x, trail=o  → RENDERS C->D
    // {o|x} + thick arrow head
    "o==>",
    // {o|x} + thick open (3+ equals)
    "o===", "o====",
    // {o|x} + thick cross head
    "x==o",
    // {o|x} + dotted open (1 dot / 2 dots)
    "o-.-", "o-..-",
    "x-.-", "x-..-",
  ];
  for (const op of renders) {
    const b = findMermaidBlocks(`graph TD\nA ${op} B`, true)[0];
    assert.equal(b.supported, true, `${op}: renders → supported:true`);
    assert.equal(b.parseError, undefined, `${op}: no parseError`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B"], `${op}: A->B edge emitted (renders, not dropped)`);
    assert.ok((b.warnings || []).some((w) => w.code === "unsupported-arrow"), `${op}: unsupported-arrow advisory present`);
  }
});

test("FIX-C renders family: A->B edge is present alongside surrounding edges (no block loss)", () => {
  // The C->D edge from the FIX-C form PLUS the surrounding A->B / E->F all survive.
  const ops = ["o---", "x---", "o--x", "x--o", "o==>", "o-.-", "x-..-"];
  for (const op of ops) {
    const b = findMermaidBlocks(`graph TD\nA-->B\nC ${op} D\nE-->F`, true)[0];
    assert.equal(b.supported, true, `${op}: supported:true`);
    assert.deepEqual(
      b.edges.map((e) => `${e.from}->${e.to}`),
      ["A->B", "C->D", "E->F"],
      `${op}: all three edges present (FIX-C edge + surroundings)`,
    );
    assert.ok((b.warnings || []).some((w) => w.code === "unsupported-arrow"), `${op}: unsupported-arrow advisory`);
  }
});

test("FIX-C renders family: warning line is the absolute document line of the FIX-C edge", () => {
  // The unsupported-arrow warning's line must be within the document's line range.
  const src = "```mermaid\ngraph TD\nA-->B\nC o--- D\nE-->F\n```";
  const b = findMermaidBlocks(src, false)[0];
  assert.equal(b.supported, true);
  assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D", "E->F"]);
  const w = (b.warnings || []).find((x) => x.code === "unsupported-arrow");
  assert.ok(w, "unsupported-arrow warning present");
  const lines = src.split("\n");
  assert.ok(w.line >= 0 && w.line < lines.length, `warning line ${w.line} is in-range`);
  assert.ok(lines[w.line] !== undefined, "warning line resolves to a real document line");
});

test("FIX-C renders family: bare `--` and `<--` are still a SKIP (multi-line-label quirk, off-contract)", () => {
  // `A -- B` and `A <-- B` are Mermaid-REJECTED standalone (not the renders class).
  // They render ONLY via an off-contract multi-line-label quirk (the contract "labels are
  // single-line"). These keep the gentle skip-warn behavior: edge dropped, supported:true.
  for (const op of ["--", "<--"]) {
    const b = findMermaidBlocks(`graph TD\nA ${op} B`, true)[0];
    assert.equal(b.supported, true, `${op}: gentle skip (not fatal)`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), [], `${op}: edge NOT emitted (off-contract quirk)`);
    assert.ok((b.warnings || []).some((w) => w.code === "unsupported-arrow"), `${op}: unsupported-arrow advisory`);
  }
  // Surroundings survive the skip
  for (const op of ["--", "<--"]) {
    const b = findMermaidBlocks(`graph TD\nP-->A\nA ${op} B\nB-->Q`, true)[0];
    assert.ok(b.edges.some((e) => e.from === "P" && e.to === "A"), `${op}: surrounding P->A survives`);
  }
});
