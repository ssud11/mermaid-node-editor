// Acceptance-corpus harness for mermaid-node-core.
//
// Runs every case in corpus.json through findMermaidBlocks and checks:
//   - valid:true  -> the block(s) under check are supported:true; nodes
//                    (id/label/shape) and edges (from/to/label) match exactly;
//                    subgraphs match where expectSubgraphs is given; every
//                    node/edge carries a non-degenerate position span.
//   - valid:false -> the parser handles it GRACEFULLY: no throw, no live
//                    nodes+edges, and either no block (expectNoBlocks) or a
//                    block that warns (supported:false / parseError) or is the
//                    documented graceful-skip (supported:true, empty model).
//
// The supported axis is asserted on BOTH arms (it was previously never checked
// for valid:true, which masked the whole-block-data-loss class: a case whose
// expectNodes/expectEdges were both [] passed on []==[] even when the parser had
// failed the whole block). An optional `expectSupported` (true/false) pins the
// axis explicitly on either arm.
//
// Exits non-zero with a per-case diff on any failure.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findMermaidBlocks } from "../src/index.js";
import { checkSpans } from "./span-net.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, "corpus.json"), "utf8"));

function normNodes(nodes) {
  return nodes.map((n) => ({ id: n.id, label: n.label, shape: n.shape }));
}
function normEdges(edges) {
  return edges.map((e) => {
    const o = { from: e.from, to: e.to };
    if (e.label !== undefined) o.label = e.label;
    return o;
  });
}
function normSubgraphs(sgs) {
  return sgs.map((s) => ({ id: s.id, label: s.label, hasId: s.hasId, members: s.members }));
}
function normExpectEdges(edges) {
  return edges.map((e) => {
    const o = { from: e.from, to: e.to };
    if (e.label !== undefined) o.label = e.label;
    return o;
  });
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A node/edge span is "real" iff it has a 0-based line and a non-degenerate
// column range that lies within the source line.
function spanLooksReal(item, lines) {
  if (typeof item.line !== "number" || item.line < 0) return false;
  if (typeof item.startChar !== "number" || typeof item.endChar !== "number") return false;
  if (item.endChar <= item.startChar) return false; // never zero-width
  const srcLine = lines[item.line];
  if (srcLine === undefined) return false;
  return item.endChar <= srcLine.length;
}

let pass = 0;
const failures = [];

for (const tc of corpus) {
  // A raw flowchart string (no markdown fence) is parsed as a whole-.mmd block;
  // a markdown document (with a ``` / ~~~ fence) is parsed fenced. `isMmd:false`
  // in the case forces markdown mode explicitly.
  const hasFence = /^\s*(```|~~~)/m.test(tc.input);
  const isMmd = tc.isMmd === true || (tc.isMmd === undefined && !hasFence);
  let blocks;
  try {
    blocks = findMermaidBlocks(tc.input, isMmd);
  } catch (err) {
    failures.push({ id: tc.id, reason: `THREW: ${err && err.message}` });
    continue;
  }
  const lines = tc.input.split(/\r?\n/);

  if (tc.valid === false) {
    // Graceful handling: no throw (already true), and no live nodes/edges.
    if (tc.expectNoBlocks) {
      if (blocks.length === 0) { pass++; continue; }
      failures.push({ id: tc.id, reason: `expected no blocks, got ${blocks.length}` });
      continue;
    }
    const liveNodes = blocks.flatMap((b) => b.nodes || []);
    const liveEdges = blocks.flatMap((b) => b.edges || []);
    if (liveNodes.length !== 0 || liveEdges.length !== 0) {
      failures.push({
        id: tc.id,
        reason: `off-contract input produced live model (must WARN, not parse): nodes=${JSON.stringify(normNodes(liveNodes))} edges=${JSON.stringify(normEdges(liveEdges))}`,
      });
      continue;
    }
    // UN-MASK (supported axis): a valid:false case must be HANDLED — each block
    // either reports supported:false / carries a parseError (an explicit WARN),
    // or is the documented graceful-skip (supported:true with an empty model,
    // e.g. a reserved-keyword edge endpoint dropped while the block survives).
    // The empty-model check above already guarantees no live content leaks; this
    // adds the supported-axis check so a future false-green here can't hide.
    // `expectSupported` (true/false) pins the axis explicitly when a case wants it.
    if (tc.expectSupported !== undefined) {
      const bad = blocks.find((b) => b.supported !== tc.expectSupported);
      if (bad) {
        failures.push({ id: tc.id, reason: `expectSupported=${tc.expectSupported} but a block was supported=${bad.supported} (parseError=${JSON.stringify(bad.parseError)})` });
        continue;
      }
    }
    pass++;
    continue;
  }

  // valid:true — combine blocks if asked, else expect exactly one block.
  // UN-MASK (supported axis): the block(s) under check MUST be supported:true.
  // Previously the harness asserted only nodes/edges/spans and NEVER referenced
  // b.supported, so a case whose expectNodes/expectEdges are both [] passed on
  // []==[] even when the parser had actually FAILED the whole block
  // (supported:false + parseError) — masking the whole-block-data-loss class.
  // A valid:true case is now required to parse cleanly (supported:true, no
  // parseError) in addition to matching the model.
  let allNodes = [];
  let allEdges = [];
  let allSubs = [];
  let supBlocks = [];
  if (tc.combineBlocks) {
    // Only the blocks that contribute model are checked for supported-ness;
    // a fenced doc may legitimately carry a non-flowchart block alongside the
    // flowchart one. Cases that need a per-block pin use the existing model
    // asserts; here we require that no contributing block is unsupported.
    supBlocks = blocks;
    for (const b of blocks) {
      allNodes.push(...(b.nodes || []));
      allEdges.push(...(b.edges || []));
      allSubs.push(...(b.subgraphs || []));
    }
  } else {
    const b = blocks[0];
    if (!b) {
      failures.push({ id: tc.id, reason: "no block returned for a valid case" });
      continue;
    }
    supBlocks = [b];
    allNodes = b.nodes || [];
    allEdges = b.edges || [];
    allSubs = b.subgraphs || [];
  }

  // The supported-axis assertion. `expectSupported:false` lets a valid:true case
  // (one that exercises the model on the supported blocks but tolerates an
  // adjacent unsupported block) opt out — but the default for valid:true is
  // supported:true on every block under check.
  const wantSupported = tc.expectSupported === undefined ? true : tc.expectSupported;
  const badSupport = supBlocks.find((b) => b.supported !== wantSupported);
  if (badSupport) {
    failures.push({
      id: tc.id,
      reason: `supported axis: expected supported=${wantSupported} but a block was supported=${badSupport.supported} (parseError=${JSON.stringify(badSupport.parseError)})`,
    });
    continue;
  }

  const gotNodes = normNodes(allNodes);
  const wantNodes = tc.expectNodes;
  if (!eq(gotNodes, wantNodes)) {
    failures.push({ id: tc.id, reason: `nodes mismatch\n   want ${JSON.stringify(wantNodes)}\n   got  ${JSON.stringify(gotNodes)}` });
    continue;
  }

  const gotEdges = normEdges(allEdges);
  const wantEdges = normExpectEdges(tc.expectEdges);
  if (!eq(gotEdges, wantEdges)) {
    failures.push({ id: tc.id, reason: `edges mismatch\n   want ${JSON.stringify(wantEdges)}\n   got  ${JSON.stringify(gotEdges)}` });
    continue;
  }

  if (tc.expectSubgraphs) {
    const gotSubs = normSubgraphs(allSubs);
    if (!eq(gotSubs, tc.expectSubgraphs)) {
      failures.push({ id: tc.id, reason: `subgraphs mismatch\n   want ${JSON.stringify(tc.expectSubgraphs)}\n   got  ${JSON.stringify(gotSubs)}` });
      continue;
    }
  }

  // Position check: every node and edge must carry a real, in-range span.
  const badSpan =
    allNodes.find((n) => !spanLooksReal(n, lines)) ||
    allEdges.find((e) => !spanLooksReal(e, lines));
  if (badSpan) {
    failures.push({
      id: tc.id,
      reason: `degenerate/out-of-range span: ${JSON.stringify({ id: badSpan.id, from: badSpan.from, to: badSpan.to, line: badSpan.line, startChar: badSpan.startChar, endChar: badSpan.endChar })}`,
    });
    continue;
  }

  // Optional span-CONTENT check: `expectNodeSpanSlices` maps a node id to the
  // exact text `lines[node.line].slice(startChar, endChar)` MUST yield. This is
  // the content-exclusive span invariant — e.g. a hyphen-truncated id's span must
  // slice to the kept id only (`send-email[Label]` → "send"), never the discarded
  // tail, so a span-edit can't overwrite off-contract text. spanLooksReal proves
  // the span is in-range; this proves it points at the RIGHT text.
  if (tc.expectNodeSpanSlices) {
    let sliceFail = null;
    for (const [nodeId, want] of Object.entries(tc.expectNodeSpanSlices)) {
      const n = allNodes.find((x) => x.id === nodeId);
      if (!n) { sliceFail = `no node with id ${JSON.stringify(nodeId)}`; break; }
      const got = lines[n.line].slice(n.startChar, n.endChar);
      if (got !== want) { sliceFail = `node ${JSON.stringify(nodeId)} span slice = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`; break; }
    }
    if (sliceFail) {
      failures.push({ id: tc.id, reason: `span-slice: ${sliceFail}` });
      continue;
    }
  }

  // Universal span-invariant net: on EVERY valid case, every node and subgraph
  // under check must have spans that slice to exactly the content the model
  // claims (label, node decl, id/title) — expected slices computed from the
  // input + parsed values, never hand-listed. This is the catch-all that proves
  // a span axis didn't silently degenerate (e.g. a zero-width label span making
  // a relabel a no-op). It runs on the blocks under check (supBlocks).
  let netFail = null;
  for (const b of supBlocks) {
    checkSpans(b, lines, (msg) => { if (!netFail) netFail = msg; });
    if (netFail) break;
  }
  if (netFail) {
    failures.push({ id: tc.id, reason: `span-net: ${netFail}` });
    continue;
  }

  pass++;
}

const total = corpus.length;
console.log(`\nmermaid-node-core corpus: ${pass}/${total} passed\n`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) {
    console.log(` ✗ ${f.id}: ${f.reason}`);
  }
  console.log("");
  process.exit(1);
}
console.log("All corpus cases pass.\n");
