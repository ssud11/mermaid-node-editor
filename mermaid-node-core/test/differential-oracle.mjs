// differential-oracle.mjs — a TEST/CI instrument, never on the runtime path.
//
// Three flowchart parsers, one normalized coverage comparison:
//
//   NEW   core           findMermaidBlocks(text, true)  from ../src/parser.js
//   OLD   regex parser   findMermaidBlocks(text, true)  from the parent project's
//                        compiled out/src/parser.js (the pre-re-plumb parser; the
//                        authoritative record of PRIOR COMMITTED COVERAGE)
//   MM    real Mermaid   v11 flow grammar -> FlowDB getVertices()/getEdges()
//                        (ground truth; breaks ties)
//
// Each parser's output is reduced to a COMMON per-input coverage shape:
//     { nodeIds: Set<string>, edges: Set<"from->to"> }
// "Coverage" = which ids/edges the parser SAW — node coverage is the union of node
// definitions AND edge endpoints, so the comparison is about what each parser
// recognized, not about definition-vs-reference bookkeeping (the parsers differ on
// whether a bare-referenced id lands in nodes[], but both carry it on the edge).
//
// Classification per input:
//   REGRESSION    old - new  non-empty  -> the new core under-covers what the old
//                                          parser produced. FAILS (non-zero exit).
//   DIVERGENCE    new != MM             -> a correctness gap of the new core vs the
//                                          ground-truth parser. Reported, not fatal.
//   INFORMATIONAL old != MM             -> the OLD parser's own bugs (Mermaid breaks
//                                          the tie). Not a new-core defect. Reported.
//
// Self-contained + reproducible: `npm run differential` from the core package.

import { findMermaidBlocks as findNew } from "../src/parser.js";
import { findMermaidBlocks as findOld } from "../../out/src/parser.js";

// --- Real Mermaid v11 flow parser (browser-only deps shimmed for Node) ----------
import * as DP from "dompurify";
const dp = DP.default || DP;
dp.addHook = dp.addHook || (() => {});
dp.sanitize = (s) => s;
dp.setConfig = dp.setConfig || (() => {});
import { diagram } from "mermaid/dist/chunks/mermaid.core/flowDiagram-I6XJVG4X.mjs";
const mmParser = diagram.parser.parser;
const mmDb = diagram.db;
mmParser.yy = mmDb;

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

// =================================================================================
// Normalizers — every parser reduced to { nodeIds:Set, edges:Set("from->to") }.
// =================================================================================

// Reduce a positioned-parser block list (new core OR old parser; identical surface:
// blocks[].{ supported, nodes[].id, edges[].{from,to}, subgraphs[].{id,members} })
// to the common coverage shape. Aggregates across ALL blocks in the document.
//
// supported:false blocks are INCLUDED in coverage because the contract exposes a
// best-effort model even for rejected forms (surrounding the contract edges are still real edges
// the parser recognized). Excluding supported:false would mis-classify correctness
// improvements (e.g. bare `--` promoted from a false-green gentle-skip to an honest
// FATAL) as regressions, since the surrounding edges ARE still in the model. The
// supported flag governs editing trust, not coverage presence.
function coverageFromBlocks(blocks) {
  const nodeIds = new Set();
  const edges = new Set();
  for (const b of blocks) {
    for (const n of b.nodes || []) nodeIds.add(n.id);
    for (const sg of b.subgraphs || []) {
      // subgraph ids + their declared members are part of what the parser "saw"
      if (sg.id) nodeIds.add(sg.id);
      for (const m of sg.members || []) nodeIds.add(m);
    }
    for (const e of b.edges || []) {
      nodeIds.add(e.from);
      nodeIds.add(e.to);
      edges.add(e.from + "->" + e.to);
    }
  }
  return { nodeIds, edges };
}

function coverageNew(input, isMmd) {
  return coverageFromBlocks(findNew(input, isMmd));
}
function coverageOld(input, isMmd) {
  return coverageFromBlocks(findOld(input, isMmd));
}

// Real Mermaid's rendering pipeline PREPROCESSES the diagram text before the flow
// grammar sees it: it strips a leading YAML `--- … ---` frontmatter block and removes
// `%%` comment lines. The raw flow grammar (`mmParser.parse`) does NOT do this, so on
// frontmatter / own-line / trailing-comment input the bare grammar wrongly throws while
// real `mermaid.parse()` renders it (verified against mermaid@11.15.0). To make this
// ground-truth column reflect what Mermaid ACTUALLY renders — not an artifact of calling
// the grammar without its front-end — we apply the same preprocessing here.
//
//   - Frontmatter: a first non-blank line `---` … up to the next `---` is dropped.
//   - Comments: every line whose first non-space chars are `%%` is dropped (an inline
//     `%%` AFTER content is NOT stripped — Mermaid itself rejects that, so leaving it
//     in keeps the grammar's reject, matching real Mermaid).
//   - If preprocessing leaves only the header (no statements), Mermaid renders an EMPTY
//     diagram (∅ coverage) — the bare grammar throws on a header-only body, so we treat
//     that specific throw as empty rather than "rejected".
function mermaidPreprocess(text) {
  let lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && lines[i].trim() === "---") {
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "---") j++;
    if (j < lines.length) lines = lines.slice(j + 1);
  }
  lines = lines.filter((l) => !/^\s*%%/.test(l));
  return lines.join("\n");
}

// Real Mermaid: parse the document's flowchart blocks the same way the others do —
// for a whole .mmd it's the whole text; for markdown, extract each ```mermaid fence
// and parse them independently, unioning coverage. Mermaid throws on input it
// rejects; a rejected block contributes empty coverage (it's "unsupported").
function coverageMermaid(input, isMmd) {
  const nodeIds = new Set();
  const edges = new Set();
  const chunks = (isMmd ? [input] : extractMermaidFences(input)).map(mermaidPreprocess);
  for (const chunk of chunks) {
    let verts, evs;
    try {
      if (mmDb.clear) mmDb.clear();
      mmParser.yy = mmDb;
      mmParser.parse(chunk);
      verts = mmDb.getVertices ? mmDb.getVertices() : new Map();
      evs = mmDb.getEdges ? mmDb.getEdges() : [];
    } catch {
      continue; // Mermaid rejected this block -> contributes nothing (unsupported)
    }
    const keys = verts instanceof Map ? [...verts.keys()] : Object.keys(verts || {});
    for (const k of keys) nodeIds.add(k);
    for (const e of evs || []) {
      if (e.start) nodeIds.add(e.start);
      if (e.end) nodeIds.add(e.end);
      if (e.start && e.end) edges.add(e.start + "->" + e.end);
    }
    // subgraph ids count as node coverage (parity with coverageFromBlocks)
    const subs = mmDb.getSubGraphs ? mmDb.getSubGraphs() : [];
    for (const s of subs || []) {
      if (s.id) nodeIds.add(s.id);
      for (const n of s.nodes || []) nodeIds.add(n);
    }
  }
  return { nodeIds, edges };
}

// Pull the content of each ```mermaid / ~~~mermaid fenced block out of markdown,
// mirroring the new core's fence scan closely enough for ground-truth coverage.
function extractMermaidFences(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const FENCE = /^(\s*)(`{3,}|~{3,})\s*(\S*)/;
  let i = 0;
  while (i < lines.length) {
    const open = FENCE.exec(lines[i]);
    if (!open) { i++; continue; }
    const fenceChar = open[2][0];
    const len = open[2].length;
    const info = open[3].toLowerCase();
    const closeRe = new RegExp("^\\s*" + fenceChar + "{" + len + ",}\\s*$");
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) j++;
    if (j >= lines.length) { i++; continue; }
    if (info === "mermaid") out.push(lines.slice(i + 1, j).join("\n"));
    i = j + 1;
  }
  return out;
}

// =================================================================================
// Set helpers
// =================================================================================
const minus = (a, b) => new Set([...a].filter((x) => !b.has(x)));
const inter = (a, b) => new Set([...a].filter((x) => b.has(x)));
const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const fmt = (s) => (s.size ? "{" + [...s].sort().join(", ") + "}" : "{}");

function covEqual(a, b) {
  return eqSet(a.nodeIds, b.nodeIds) && eqSet(a.edges, b.edges);
}
function covMinus(a, b) {
  return { nodeIds: minus(a.nodeIds, b.nodeIds), edges: minus(a.edges, b.edges) };
}
// the part of coverage `d` that real Mermaid also confirms (intersect with ground truth)
function covConfirmedBy(d, mm) {
  return { nodeIds: inter(d.nodeIds, mm.nodeIds), edges: inter(d.edges, mm.edges) };
}
function covNonEmpty(d) {
  return d.nodeIds.size > 0 || d.edges.size > 0;
}

// =================================================================================
// Input set: corpus valid cases + a generated arrow/shape/subgraph cross-product
// =================================================================================

function corpusInputs() {
  const corpus = JSON.parse(readFileSync(join(__dir, "corpus.json"), "utf8"));
  return corpus
    .filter((c) => c.valid !== false) // only valid inputs (oracle coverage is meaningful)
    .map((c) => ({ id: "corpus:" + c.id, input: c.input, isMmd: true }));
}

// Arrow cross-product — every arrow embedded between two plain edges so a dropped
// suspect edge is visible against surviving neighbours.
//   dir:    fwd | rev | bidir
//   stroke: solid (-) | thick (=) | dotted (.)
//   head:   arrow (>) | open () | o | x
//   shaft:  length 1..3 (extra dashes only change rendered length, same edge)
function buildArrowToken(dir, stroke, head, shaftLen) {
  const dash = stroke === "thick" ? "=" : stroke === "dotted" ? "." : "-";
  // A dotted shaft is `-.-` style: a dot framed by dashes; lengthen by repeating the dot.
  let shaft;
  if (stroke === "dotted") {
    shaft = "-" + ".".repeat(shaftLen) + "-";
  } else {
    shaft = dash.repeat(shaftLen + 1); // len1 => 2 chars (`--`/`==`), grows with len
  }
  const tail = head === "arrow" ? ">" : head === "open" ? "" : head; // o / x literal
  if (dir === "fwd") return shaft + tail;
  if (dir === "rev") return (head === "arrow" ? "<" : head) + shaft;
  // bidir: a head on both ends
  const lead = head === "arrow" ? "<" : head;
  return lead + shaft + tail;
}

function generatedArrowInputs() {
  const dirs = ["fwd", "rev", "bidir"];
  const strokes = ["solid", "thick", "dotted"];
  const heads = ["arrow", "open", "o", "x"];
  const shafts = [1, 2, 3];
  const inputs = [];
  for (const dir of dirs)
    for (const stroke of strokes)
      for (const head of heads)
        for (const shaftLen of shafts) {
          const tok = buildArrowToken(dir, stroke, head, shaftLen);
          // Embedded between two plain edges (P0-->A, B-->P1) so a swallowed
          // suspect edge stands out against the surviving plain neighbours.
          const input = `graph TD\nP0 --> A\nA ${tok} B\nB --> P1`;
          inputs.push({
            id: `arrow:${dir}/${stroke}/${head}/len${shaftLen} [${tok}]`,
            input,
            isMmd: true,
          });
        }
  return inputs;
}

function generatedShapeInputs() {
  const shapes = [
    ["rect", "X[Label]"],
    ["round", "X(Label)"],
    ["stadium", "X([Label])"],
    ["subroutine", "X[[Label]]"],
    ["cylinder", "X[(Label)]"],
    ["circle", "X((Label))"],
    ["diamond", "X{Label}"],
    ["hexagon", "X{{Label}}"],
    ["asymmetric", "X>Label]"],
    ["quoted", 'X["Label here"]'],
  ];
  return shapes.map(([name, def]) => ({
    id: `shape:${name}`,
    input: `graph TD\nP0 --> ${def}\nX --> P1`,
    isMmd: true,
  }));
}

function generatedSubgraphInputs() {
  return [
    {
      id: "subgraph:id+title",
      input: "graph TD\nsubgraph S1[Group One]\nA --> B\nend\nC --> A",
      isMmd: true,
    },
    {
      id: "subgraph:plain-id",
      input: "graph TD\nsubgraph S2\nA --> B\nend\nB --> C",
      isMmd: true,
    },
    {
      id: "subgraph:nested",
      input: "graph TD\nsubgraph Outer\nsubgraph Inner\nA --> B\nend\nB --> C\nend\nC --> A",
      isMmd: true,
    },
    {
      id: "subgraph:fanout-inside",
      input: "graph TD\nsubgraph S\nA --> B & C\nend\nC --> D",
      isMmd: true,
    },
  ];
}

function allInputs() {
  return [
    ...corpusInputs(),
    ...generatedArrowInputs(),
    ...generatedShapeInputs(),
    ...generatedSubgraphInputs(),
  ];
}

// =================================================================================
// Run + classify
// =================================================================================

function run() {
  const inputs = allInputs();
  const regressions = [];     // FATAL: new lost coverage the old parser had AND Mermaid confirms
  const oldArtifacts = [];    // non-fatal: old had it, new dropped it, but Mermaid rejects it too
  const divergences = [];     // new != Mermaid (new core's own correctness gap)
  const informationals = [];  // old != Mermaid (the old parser's own bugs)

  for (const { id, input, isMmd } of inputs) {
    let nw, old, mm;
    try {
      nw = coverageNew(input, isMmd);
    } catch (err) {
      // the new core must never throw — a throw IS a regression-class defect
      regressions.push({ id, input, kind: "new-core-threw", error: String(err).slice(0, 200) });
      continue;
    }
    old = coverageOld(input, isMmd);
    mm = coverageMermaid(input, isMmd);

    // Raw "old - new": coverage the old parser produced that the new core does not.
    // Split it by whether Mermaid (ground truth) also confirms that coverage:
    //   confirmed-by-Mermaid -> a GENUINE regression: real, prior-committed coverage
    //                           the new core lost. FATAL.
    //   not-confirmed        -> the old parser's OWN artifact (a truncation/phantom id
    //                           Mermaid rejects too); the new core CORRECTLY declines to
    //                           reproduce it. Non-fatal — reported as an old-artifact.
    // (This is the "Mermaid breaks ties; the old parser's bugs are not a new-core
    //  defect" rule applied to the regression gate — otherwise the new core would be
    //  forced to RE-INTRODUCE old bugs to pass.)
    const lostRaw = covMinus(old, nw);
    if (covNonEmpty(lostRaw)) {
      const lostConfirmed = covConfirmedBy(lostRaw, mm);
      if (covNonEmpty(lostConfirmed)) {
        regressions.push({ id, input, lost: lostConfirmed, lostRaw, new: nw, old, mm });
      } else {
        oldArtifacts.push({ id, input, lostRaw, new: nw, old, mm });
      }
    }

    // DIVERGENCE: new != Mermaid (new core's own correctness gap vs ground truth)
    if (!covEqual(nw, mm)) {
      divergences.push({
        id,
        input,
        newMinusMm: covMinus(nw, mm), // new produced these, Mermaid didn't
        mmMinusNew: covMinus(mm, nw), // Mermaid has these, new core missed
        new: nw,
        old,
        mm,
      });
    }

    // INFORMATIONAL: old != Mermaid (the OLD parser's own bugs; not a new-core defect)
    if (!covEqual(old, mm)) {
      informationals.push({
        id,
        input,
        oldMinusMm: covMinus(old, mm),
        mmMinusOld: covMinus(mm, old),
        old,
        mm,
      });
    }
  }

  return { total: inputs.length, regressions, oldArtifacts, divergences, informationals };
}

function printCoverageTriple(f) {
  if (f.new) console.log(`      NEW   nodes=${fmt(f.new.nodeIds)} edges=${fmt(f.new.edges)}`);
  if (f.old) console.log(`      OLD   nodes=${fmt(f.old.nodeIds)} edges=${fmt(f.old.edges)}`);
  if (f.mm)  console.log(`      MM    nodes=${fmt(f.mm.nodeIds)} edges=${fmt(f.mm.edges)}`);
}

function report({ total, regressions, oldArtifacts, divergences, informationals }) {
  const line = "=".repeat(78);
  console.log(line);
  console.log("DIFFERENTIAL ORACLE — new core vs old regex parser vs real Mermaid v11");
  console.log(line);
  console.log(`Inputs evaluated:           ${total}`);
  console.log(`REGRESSIONS (lost & MM-confirmed): ${regressions.length}   ${regressions.length ? "*** FAIL ***" : "(none)"}`);
  console.log(`OLD-ARTIFACTS (old had, MM rejects, new drops): ${oldArtifacts.length}   (non-fatal — new core correctly declines the old bug)`);
  console.log(`DIVERGENCES (new != MM):    ${divergences.length}   (new core's own correctness gaps vs ground truth)`);
  console.log(`INFORMATIONAL (old != MM):  ${informationals.length}   (old parser's own bugs; Mermaid breaks ties)`);
  console.log(line);

  if (regressions.length) {
    console.log("\n## REGRESSIONS — new core lost coverage the old parser had AND Mermaid confirms (FATAL)\n");
    for (const f of regressions) {
      console.log(`  [${f.id}]`);
      console.log(`      input: ${JSON.stringify(f.input)}`);
      if (f.kind === "new-core-threw") {
        console.log(`      NEW CORE THREW: ${f.error}`);
        continue;
      }
      console.log(`      LOST (MM-confirmed) nodes=${fmt(f.lost.nodeIds)} edges=${fmt(f.lost.edges)}`);
      printCoverageTriple(f);
    }
  }

  if (oldArtifacts.length) {
    console.log("\n## OLD-ARTIFACTS — old parser produced ids/edges Mermaid rejects; new core correctly drops them (non-fatal)\n");
    for (const f of oldArtifacts) {
      console.log(`  [${f.id}]`);
      console.log(`      input: ${JSON.stringify(f.input)}`);
      console.log(`      old-only (MM also rejects) nodes=${fmt(f.lostRaw.nodeIds)} edges=${fmt(f.lostRaw.edges)}`);
      printCoverageTriple(f);
    }
  }

  if (divergences.length) {
    console.log("\n## DIVERGENCES — new core vs real Mermaid (correctness gaps)\n");
    for (const f of divergences) {
      console.log(`  [${f.id}]`);
      console.log(`      input: ${JSON.stringify(f.input)}`);
      console.log(`      new-extra (new has, MM lacks) nodes=${fmt(f.newMinusMm.nodeIds)} edges=${fmt(f.newMinusMm.edges)}`);
      console.log(`      new-missing (MM has, new lacks) nodes=${fmt(f.mmMinusNew.nodeIds)} edges=${fmt(f.mmMinusNew.edges)}`);
      printCoverageTriple(f);
    }
  }

  if (informationals.length) {
    console.log("\n## INFORMATIONAL — old parser vs real Mermaid (old parser's own bugs)\n");
    for (const f of informationals) {
      console.log(`  [${f.id}]`);
      console.log(`      input: ${JSON.stringify(f.input)}`);
      console.log(`      old-extra (old has, MM lacks) nodes=${fmt(f.oldMinusMm.nodeIds)} edges=${fmt(f.oldMinusMm.edges)}`);
      console.log(`      old-missing (MM has, old lacks) nodes=${fmt(f.mmMinusOld.nodeIds)} edges=${fmt(f.mmMinusOld.edges)}`);
      printCoverageTriple(f);
    }
  }

  console.log("\n" + line);
  console.log(regressions.length ? "RESULT: FAIL — regressions present" : "RESULT: PASS — no regressions vs the old parser");
  console.log(line);
}

// =================================================================================
// Block-detection leg (imported separately to keep the file scoped)
// =================================================================================
import { runBlockDetectionLeg, reportBlockDetectionLeg } from "./block-detection-oracle.mjs";

const result = run();
report(result);

console.log("\n");
const bdResult = runBlockDetectionLeg();
const bdExitCode = reportBlockDetectionLeg(bdResult);

// Fail if either leg has failures.
const contentLegFailed = result.regressions.length > 0 ? 1 : 0;
process.exit(contentLegFailed || bdExitCode ? 1 : 0);
