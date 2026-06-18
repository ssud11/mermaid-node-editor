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
  // `style[L] --> B[End]` is off-contract (reserved id as edge source). The
  // directive rule must NOT consume the whole line and silently drop B — the
  // destination node survives; the reserved-source edge is dropped per the
  // reserved-id limitation.
  for (const src of ["flowchart TD\nstyle[Label] --> B[End]", "flowchart TD\nstyle[L] ==> B[End]"]) {
    const b = findMermaidBlocks(src, true)[0];
    assert.equal(b.supported, true, `still supported: ${src}`);
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
test("inline-label edge family: every close-kind/shaft/quoting arm is ONE labeled edge", () => {
  const arms = [
    // [input, expectedLabel]
    ["A -- lbl --> B", "lbl"], ["A -- lbl ---> B", "lbl"], ["A -- lbl ----> B", "lbl"],
    ["A -- lbl -- B", "lbl"], ["A -- lbl --- B", "lbl"], ["A -- lbl ---- B", "lbl"], ["A -- lbl ----- B", "lbl"],
    ["A == lbl ==> B", "lbl"], ["A == lbl ===> B", "lbl"],
    ["A == lbl == B", "lbl"], ["A == lbl === B", "lbl"], ["A == lbl ==== B", "lbl"],
    ['A -- "q l" --> B', "q l"], ['A -- "q l" --- B', "q l"], ["A -- 'q l' -- B", "q l"],
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

test("inline-label edge family: an embedded dash run inside a label is preserved (open close is whitespace-delimited)", () => {
  for (const [body, label] of [["A -- a--b --- B", "a--b"], ["A -- a---b ---- B", "a---b"], ["A -- a--b --> B", "a--b"]]) {
    const e = findMermaidBlocks(`graph TD\n${body}`, true)[0].edges[0];
    assert.equal(e.label, label, `${body}: embedded dashes kept`);
  }
});

// Reserved-keyword family: {keyword} × {standalone-shaped, edge-endpoint}. A
// standalone shaped reserved keyword is skipped, the surrounding edges survive
// (no whole-block data loss); a reserved edge endpoint drops only that edge.
test("reserved-keyword family: a standalone shaped reserved node is skipped, surroundings survive", () => {
  for (const kw of ["style", "graph", "flowchart", "subgraph", "direction", "click", "classDef", "class", "linkStyle", "default", "end"]) {
    const b = findMermaidBlocks(`graph TD\nA-->B\n${kw}[X]\nC-->D`, true)[0];
    assert.equal(b.supported, true, `${kw}[X]: block survives (supported)`);
    assert.equal(b.nodes.length, 0, `${kw}[X]: dropped, no node`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"], `${kw}[X]: surrounding edges survive`);
  }
});

test("reserved-keyword family: a bare `end` still terminates a subgraph (not eaten by recovery)", () => {
  const b = findMermaidBlocks("graph TD\nsubgraph S\nA-->B\nend\nC-->D", true)[0];
  assert.equal(b.supported, true);
  assert.deepEqual(b.subgraphs.map((s) => s.id), ["S"]);
  assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"]);
  // and a SHAPED end[X] inside a subgraph is dropped while the bare end still closes it
  const b2 = findMermaidBlocks("graph TD\nsubgraph S\nA-->B\nend[X]\nend\nC-->D", true)[0];
  assert.equal(b2.supported, true);
  assert.deepEqual(b2.subgraphs.map((s) => s.id), ["S"]);
  assert.deepEqual(b2.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"]);
});

test("reserved-keyword family: a reserved edge endpoint drops only that edge, surroundings survive", () => {
  for (const kw of ["end", "style", "class", "graph"]) {
    const b = findMermaidBlocks(`graph TD\nA-->B\nX-->${kw}\nC-->D`, true)[0];
    assert.equal(b.supported, true, `X-->${kw}: block survives`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"], `X-->${kw}: only that edge dropped`);
  }
});

// Hyphenated-span family: {bare, shaped} × {hyphenated, plain}. The node span must
// slice to the kept id for a hyphen-truncated id (so a span-edit can't overwrite
// the discarded tail), and to the whole node text for a plain shaped id.
test("hyphenated-span family: a SHAPED hyphenated id's span is bounded to the kept id (slice === id)", () => {
  for (const body of ["send-email[Label]", "send-email(R)", "send-email{D}", "send-email([S])", "send-email[[Sub]]"]) {
    const src = `graph TD\n${body}`;
    const n = findMermaidBlocks(src, true)[0].nodes[0];
    assert.equal(n.id, "send", `${body}: id truncated to send`);
    assert.equal(src.split("\n")[n.line].slice(n.startChar, n.endChar), "send", `${body}: span slices to kept id, not the discarded tail`);
  }
  // multi-hyphen
  const n2 = findMermaidBlocks("graph TD\na-b-c-d[Z]", true)[0].nodes[0];
  assert.equal("graph TD\na-b-c-d[Z]".split("\n")[n2.line].slice(n2.startChar, n2.endChar), "a");
  // as an edge source
  const b3 = findMermaidBlocks("graph TD\nsend-email[L] --> B", true)[0];
  const ns = b3.nodes.find((x) => x.id === "send");
  assert.equal("graph TD\nsend-email[L] --> B".split("\n")[ns.line].slice(ns.startChar, ns.endChar), "send");
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
  // The reserved-id skip is on the 5th line (0-based 4) of the document.
  const src = "# Doc\n\n```mermaid\ngraph TD\nEnd[X]\n```";
  const b = findMermaidBlocks(src, false)[0];
  assert.equal(b.supported, true);
  const w = (b.warnings || []).find((x) => x.code === "reserved-id");
  assert.ok(w, "reserved-id warning present");
  assert.equal(w.line, 4, "warning line is the absolute document line of End[X]");
});

// B1 — reserved-keyword node id recovery is CASE-INSENSITIVE.
test("v1.4 B1: a mixed/upper-case reserved node id is recovered case-insensitively + warned, never block-fatal", () => {
  for (const kw of ["End", "STYLE", "Graph", "ClassDef", "SUBGRAPH", "Direction"]) {
    const b = findMermaidBlocks(`graph TD\nA-->B\n${kw}[X]\nC-->D`, true)[0];
    assert.equal(b.supported, true, `${kw}[X]: block survives (supported)`);
    assert.equal(b.nodes.length, 0, `${kw}[X]: skipped, no node`);
    assert.deepEqual(b.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "C->D"], `${kw}[X]: surrounding edges survive`);
    assert.deepEqual(codesOf(b), ["reserved-id"], `${kw}[X]: reserved-id warning`);
  }
  // a mixed-case bare `End` still must NOT be recovered as a shaped node when bare
  // (no shape) — but a mixed-case SHAPED end[X] is recovered like the others above.
});

// B2 — a reserved keyword as a subgraph id is kept + warned; the edge referencing
// it is dropped with its own warning (never silently).
test("v1.4 B2: reserved keyword as a subgraph id is kept + warned, the referencing edge drop is advised", () => {
  const b = findMermaidBlocks("graph TD\nsubgraph graph[Title]\n  C --> graph\nend", true)[0];
  assert.equal(b.supported, true);
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

// B4 — a FOREIGN close-bracket inside an unquoted label is kept as content (it
// renders in Mermaid); the over-bracket guard still hard-fails.
test("v1.4 B4: a foreign close-bracket inside an unquoted label is part of the label", () => {
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
    assert.equal(b.supported, true, `${body}: supported`);
    const n = b.nodes[0];
    assert.equal(n.label, label, `${body}: label keeps the foreign bracket`);
    assert.equal(n.shape, shape, `${body}: shape`);
    // span-content invariant: the label span still slices to exactly the label
    assert.equal(src.split("\n")[n.line].slice(n.labelStart, n.labelEnd), label, `${body}: label span slices to content`);
    assert.deepEqual(codesOf(b), [], `${body}: a parsed canonical-shape label carries no warning`);
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

test("v1.4 C: a hyphen-truncated id carries the id-truncated advisory (bare, shaped, endpoint)", () => {
  for (const body of ["send-email", "send-email[L]", "send-email --> B", "A --> recv-order"]) {
    const b = findMermaidBlocks(`graph TD\n${body}`, true)[0];
    assert.deepEqual(codesOf(b), ["id-truncated"], `${body}: id-truncated advisory`);
  }
  // a plain (non-hyphenated) id carries no advisory
  assert.deepEqual(codesOf(findMermaidBlocks("graph TD\nplain --> B", true)[0]), []);
});

test("v1.4: a backtracked speculative path leaves NO spurious warning (model-attached, not a shared array)", () => {
  // `A -- a--b --- B` exercises the inline-dash label path with an embedded dash run;
  // the parser backtracks across several Link alternatives before committing. Exactly
  // one inline-dash-label advisory must survive — not one per speculative attempt.
  const b = findMermaidBlocks("graph TD\nA -- a--b --- B", true)[0];
  assert.equal(b.edges[0].label, "a--b");
  assert.deepEqual(codesOf(b), ["inline-dash-label"]);
  // and a clean canonical chain after a fan-out line keeps warnings scoped per block
  const b2 = findMermaidBlocks("graph TD\nA --> B & C\nD --> E", true)[0];
  assert.deepEqual(b2.edges.map((e) => `${e.from}->${e.to}`), ["A->B", "A->C", "D->E"]);
  assert.deepEqual(codesOf(b2), ["fanout-split"]);
});
