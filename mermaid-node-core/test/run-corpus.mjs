// Acceptance-corpus harness for mermaid-node-core.
//
// Runs every case in corpus.json through findMermaidBlocks and checks:
//   - valid:true  -> nodes (id/label/shape) and edges (from/to/label) match
//                    exactly; subgraphs match where expectSubgraphs is given;
//                    every node/edge carries a non-degenerate position span.
//   - valid:false -> the parser handles it GRACEFULLY: no throw, and either no
//                    block is returned (expectNoBlocks) or the block is
//                    supported:false / carries no nodes+edges (off-contract).
//
// Exits non-zero with a per-case diff on any failure.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findMermaidBlocks } from "../src/index.js";

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
    if (liveNodes.length === 0 && liveEdges.length === 0) { pass++; continue; }
    failures.push({
      id: tc.id,
      reason: `off-contract input produced live model (must WARN, not parse): nodes=${JSON.stringify(normNodes(liveNodes))} edges=${JSON.stringify(normEdges(liveEdges))}`,
    });
    continue;
  }

  // valid:true — combine blocks if asked, else expect exactly one block.
  let allNodes = [];
  let allEdges = [];
  let allSubs = [];
  if (tc.combineBlocks) {
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
    allNodes = b.nodes || [];
    allEdges = b.edges || [];
    allSubs = b.subgraphs || [];
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
