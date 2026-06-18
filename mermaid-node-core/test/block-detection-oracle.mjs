// block-detection-oracle.mjs — block-DETECTION leg of the differential oracle.
//
// Validates that `findMermaidBlocks(text, false)` detects the same set of live
// mermaid fences that markdown-it (the CommonMark renderer VS Code uses) does.
//
// Ground truth: markdown-it parses the document and emits a `fence` token for
// every CommonMark-legal fenced code block. A fence is a "live mermaid block"
// when the first whitespace-delimited token of its info string is exactly
// `"mermaid"` (case-sensitive — Mermaid itself is case-sensitive on the info
// token; `MERMAID` does NOT activate the Mermaid renderer).
//
// Blockquote fences are a DECIDED off-contract limitation: markdown-it renders
// them (they appear as `fence` tokens inside a `blockquote_open / blockquote_close`
// pair) but `findMermaidBlocks` intentionally does not detect them. A
// markdown-it-detects-but-ours-does-not result on a blockquoted fence is
// classified as KNOWN (informational), NOT a fatal divergence.
//
// Any other disagreement between our count and markdown-it's count is an
// UNEXPECTED divergence and fails the leg.
//
// Classification of every test case:
//   UNEXPECTED_FP  ours detects N but markdown-it detects fewer   (false-positive risk:
//                  we'd write into prose that the renderer treats as literal code)
//   UNEXPECTED_FN  markdown-it detects N but ours detects fewer    (false-negative:
//                  coverage gap; the renderer sees a block we miss — not blockquote)
//   KNOWN_FN       markdown-it count > ours ONLY because of blockquoted fences
//                  (off-contract, expected; classified informational)
//   PASS           counts agree

import { findMermaidBlocks } from "../src/parser.js";
import MarkdownIt from "markdown-it";

const md = new MarkdownIt();

// ---------------------------------------------------------------------------
// markdown-it ground-truth helpers
// ---------------------------------------------------------------------------

// Count `fence` tokens in a flat markdown-it token array that are
//   (a) NOT inside a blockquote_open/close bracket, and
//   (b) whose info string's first word (trimmed, split on whitespace) === "mermaid"
// This is the "top-level mermaid fence" count — the set of blocks our parser
// is expected to detect.
function countTopLevelMermaidFences(tokens) {
  let count = 0;
  let depth = 0;
  for (const t of tokens) {
    if (t.type === "blockquote_open") { depth++; continue; }
    if (t.type === "blockquote_close") { depth--; continue; }
    if (t.type === "fence" && depth === 0) {
      const firstWord = t.info.trim().split(/\s+/)[0];
      if (firstWord === "mermaid") count++;
    }
  }
  return count;
}

// Count ALL mermaid fences markdown-it finds (including blockquote-nested ones).
function countAllMermaidFences(tokens) {
  let count = 0;
  for (const t of tokens) {
    if (t.type === "fence") {
      const firstWord = t.info.trim().split(/\s+/)[0];
      if (firstWord === "mermaid") count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Our parser: how many blocks does findMermaidBlocks detect?
// ---------------------------------------------------------------------------
function countOurBlocks(doc) {
  return findMermaidBlocks(doc, false).length;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------
// Each entry: { id, doc, notes? }
// `notes` is shown in the KNOWN section; absent for cases that should PASS.

// Helper to build a markdown document with CRLF line endings.
function crlf(s) { return s.replace(/\n/g, "\r\n"); }

// A minimal valid diagram body (does not need to be parsed correctly — we are
// only checking BLOCK DETECTION here, not diagram content).
const BODY = "graph TD\nA --> B";

const CASES = [
  // ── indent variants ────────────────────────────────────────────────────────
  {
    id: "indent:0",
    doc: "```mermaid\n" + BODY + "\n```",
  },
  {
    id: "indent:1",
    doc: " ```mermaid\n" + BODY + "\n```",
  },
  {
    id: "indent:2",
    doc: "  ```mermaid\n" + BODY + "\n```",
  },
  {
    id: "indent:3",
    doc: "   ```mermaid\n" + BODY + "\n```",
  },
  {
    id: "indent:4_not_a_fence",
    doc: "    ```mermaid\n" + BODY + "\n    ```",
    // 4-space indent: CommonMark renders this as literal indented code, not a fence.
    // Both our parser and markdown-it should detect 0 mermaid blocks.
  },
  {
    id: "indent:5_not_a_fence",
    doc: "     ```mermaid\n" + BODY + "\n     ```",
  },
  {
    id: "indent:tab_not_a_fence",
    doc: "\t```mermaid\n" + BODY + "\n\t```",
    // A leading tab counts as 4 columns under CommonMark — treated as literal code.
  },
  // ── fence character ────────────────────────────────────────────────────────
  {
    id: "fence_char:backtick",
    doc: "```mermaid\n" + BODY + "\n```",
  },
  {
    id: "fence_char:tilde",
    doc: "~~~mermaid\n" + BODY + "\n~~~",
  },
  // ── info-string variants ───────────────────────────────────────────────────
  {
    id: "info:mermaid",
    doc: "```mermaid\n" + BODY + "\n```",
  },
  {
    id: "info:MERMAID_uppercase_not_detected",
    doc: "```MERMAID\n" + BODY + "\n```",
    // markdown-it preserves case; our parser lowercases — both should give 0 (mismatch).
    // Actually: our parser lowercases info ("mermaid" matches), markdown-it case-sensitive
    // rule means firstWord "MERMAID" !== "mermaid" — so markdown-it: 0, ours: 1.
    // This is an UNEXPECTED false-positive from our parser.
    // We document it here and let the leg classify it.
  },
  {
    id: "info:Mermaid_mixed_case_not_detected",
    doc: "```Mermaid\n" + BODY + "\n```",
    // Same situation: our parser lowercases but markdown-it ground truth is case-sensitive.
  },
  {
    id: "info:mermaid_with_extra_tokens",
    doc: "```mermaid {init: {'theme': 'dark'}}\n" + BODY + "\n```",
    // info first word is "mermaid" — should be detected by both.
  },
  {
    id: "info:mermaidjs_not_mermaid",
    doc: "```mermaidjs\n" + BODY + "\n```",
    // "mermaidjs" !== "mermaid" — neither our parser nor markdown-it should detect.
  },
  // ── CRLF line endings ──────────────────────────────────────────────────────
  {
    id: "crlf:basic",
    doc: crlf("```mermaid\n" + BODY + "\n```"),
  },
  {
    id: "crlf:multiple_blocks",
    doc: crlf("```mermaid\n" + BODY + "\n```\n\nSome text\n\n```mermaid\n" + BODY + "\n```"),
  },
  // ── unterminated fence ─────────────────────────────────────────────────────
  {
    id: "unterminated:single",
    doc: "```mermaid\n" + BODY,
    // markdown-it: treats an unterminated fence as a live code block (content to
    // EOF). Our parser: intentionally skips unterminated fences — documented in
    // the source: "skip only this opener so it can't capture the file." This is a
    // deliberate conservative departure from CommonMark, not a bug.
    knownDesignDivergence: true,
    notes: "unterminated fence — ours intentionally skips (safe-file-capture guard); markdown-it renders to EOF",
  },
  {
    id: "unterminated:then_valid",
    doc: "```mermaid\n" + BODY + "\n\n```mermaid\n" + BODY + "\n```",
    // The first opener has no matching closer (the second fence's opener becomes its
    // closer because markdown-it's fence rule matches the next ``` line). markdown-it
    // emits 1 fence total (the whole remaining text as the first fence's content).
    // Our parser: skips the unterminated first fence; finds and returns the second.
    // Both parsers return 1 — but for different reasons. Counted as a pass.
  },
  // ── fence inside a list item ───────────────────────────────────────────────
  {
    id: "list_item:indented_fence",
    doc: "- Item\n\n  ```mermaid\n  " + BODY.replace(/\n/g, "\n  ") + "\n  ```",
    // markdown-it: fence inside a list item is still a top-level fence token
    // (not inside blockquote_open/close — list items use bullet_list / list_item
    // wrappers, not blockquote). Our parser should also detect it (not 4+ spaces
    // — the 2-space list indent leaves only 2 spaces before the backticks).
  },
  // ── blockquote fences (off-contract / known) ───────────────────────────────
  {
    id: "blockquote:basic",
    doc: "> ```mermaid\n> " + BODY.replace(/\n/g, "\n> ") + "\n> ```",
    // markdown-it: detects 1 (inside blockquote). Our parser: 0 (off-contract).
    // The blockquote_open wrapper flags it as KNOWN_FN, not UNEXPECTED_FN.
    notes: "blockquote-nested fence — off-contract; ours intentionally skips (KNOWN_FN expected)",
  },
  {
    id: "blockquote:and_top_level",
    doc: "```mermaid\n" + BODY + "\n```\n\n> ```mermaid\n> " + BODY.replace(/\n/g, "\n> ") + "\n> ```",
    // markdown-it total: 2 (1 top-level + 1 blockquote). Top-level: 1.
    // Our parser: 1. Counts agree for top-level; the blockquote one is KNOWN_FN.
    notes: "one top-level (agree) + one blockquote-nested (known off-contract KNOWN_FN)",
  },
  // ── longer closing fence ───────────────────────────────────────────────────
  {
    id: "longer_closer:backtick",
    doc: "```mermaid\n" + BODY + "\n````",
    // A closing fence with MORE chars than the opener is valid in CommonMark.
    // markdown-it: detects 1. Our parser: should detect 1.
  },
  // ── leading BOM ───────────────────────────────────────────────────────────
  {
    id: "leading_bom",
    doc: "﻿```mermaid\n" + BODY + "\n```",
    // A BOM at the start: markdown-it strips it; our parser should handle it.
  },
  // ── leading blank lines ────────────────────────────────────────────────────
  {
    id: "leading_blank_lines",
    doc: "\n\n\n```mermaid\n" + BODY + "\n```",
  },
  // ── multiple blocks in one document ───────────────────────────────────────
  {
    id: "multiple:two_blocks",
    doc: "```mermaid\n" + BODY + "\n```\n\nSome prose between.\n\n```mermaid\ngraph LR\nC --> D\n```",
  },
  {
    id: "multiple:mixed_info",
    doc: "```mermaid\n" + BODY + "\n```\n\n```python\nprint('hi')\n```\n\n```mermaid\ngraph LR\nC --> D\n```",
    // Two mermaid blocks + one non-mermaid; should detect 2.
  },
  // ── nested outer fence (longer outer, shorter inner) ──────────────────────
  {
    id: "nested_outer:longer_outer",
    doc: "````md\n```mermaid\n" + BODY + "\n```\n````",
    // Outer fence is 4 backticks; inner ``` is content of the outer.
    // markdown-it: 0 mermaid fences (the outer captures everything).
    // Our parser: also 0 (the inner ``` is content inside the outer block;
    // the outer info is "md", not "mermaid").
  },
];

// ---------------------------------------------------------------------------
// Run the leg
// ---------------------------------------------------------------------------
export function runBlockDetectionLeg() {
  const unexpected_fp = [];  // ours > markdown-it top-level (false-positive)
  const unexpected_fn = [];  // markdown-it top-level > ours (false-negative, not blockquote)
  const known_fn = [];       // difference only due to blockquote-nested fences or a documented
                              // design divergence (off-contract / intentional; informational)
  const passes = [];

  for (const { id, doc, notes, knownDesignDivergence } of CASES) {
    const tokens = md.parse(doc, {});
    const miTopLevel = countTopLevelMermaidFences(tokens);
    const miAll = countAllMermaidFences(tokens);
    const miBlockquoteOnly = miAll - miTopLevel; // count of blockquote-nested mermaid fences

    let ours;
    try {
      ours = countOurBlocks(doc);
    } catch (err) {
      // Our parser must never throw — a throw is a bug.
      unexpected_fp.push({
        id,
        doc,
        notes: notes || "",
        miTopLevel,
        ours: "THREW",
        error: String(err).slice(0, 200),
      });
      continue;
    }

    if (ours === miTopLevel) {
      // Counts agree on top-level fences. If markdown-it also found blockquote
      // fences, that delta is expected (off-contract).
      if (miBlockquoteOnly > 0) {
        known_fn.push({ id, doc, notes: notes || "", miTopLevel, miAll, miBlockquoteOnly, ours });
      } else {
        passes.push({ id, ours, miTopLevel });
      }
    } else if (knownDesignDivergence) {
      // A case whose divergence was anticipated and documented above — the parser
      // intentionally behaves differently from CommonMark for a stated reason.
      // Classify as KNOWN regardless of the direction of the difference.
      known_fn.push({ id, doc, notes: notes || "", miTopLevel, miAll, miBlockquoteOnly, ours });
    } else if (ours > miTopLevel) {
      // Our parser detects MORE than markdown-it's top-level count.
      unexpected_fp.push({ id, doc, notes: notes || "", miTopLevel, miAll, miBlockquoteOnly, ours });
    } else {
      // ours < miTopLevel: we miss some top-level fences.
      // miTopLevel already EXCLUDES blockquote fences, so any shortfall here
      // is a genuine false-negative (not the off-contract path).
      unexpected_fn.push({ id, doc, notes: notes || "", miTopLevel, miAll, miBlockquoteOnly, ours });
    }
  }

  return {
    total: CASES.length,
    passes,
    unexpected_fp,
    unexpected_fn,
    known_fn,
  };
}

// ---------------------------------------------------------------------------
// Reporter (matches the style of differential-oracle.mjs)
// ---------------------------------------------------------------------------
export function reportBlockDetectionLeg(result) {
  const { total, passes, unexpected_fp, unexpected_fn, known_fn } = result;
  const unexpected = unexpected_fp.length + unexpected_fn.length;
  const line = "=".repeat(78);

  console.log(line);
  console.log("BLOCK-DETECTION LEG — findMermaidBlocks vs markdown-it (CommonMark ground truth)");
  console.log(line);
  console.log(`Cases evaluated:              ${total}`);
  console.log(`PASS (counts agree):          ${passes.length}`);
  console.log(`UNEXPECTED_FP (ours > mi):    ${unexpected_fp.length}   ${unexpected_fp.length ? "*** FAIL ***" : "(none)"}`);
  console.log(`UNEXPECTED_FN (mi > ours):    ${unexpected_fn.length}   ${unexpected_fn.length ? "*** FAIL ***" : "(none)"}`);
  console.log(`KNOWN (off-contract/design): ${known_fn.length}   (expected; informational)`);
  console.log(line);

  if (unexpected_fp.length) {
    console.log("\n## UNEXPECTED FALSE-POSITIVES — ours detects blocks markdown-it does not (write-into-prose risk)\n");
    for (const f of unexpected_fp) {
      console.log(`  [${f.id}]`);
      if (f.notes) console.log(`      notes: ${f.notes}`);
      if (f.ours === "THREW") {
        console.log(`      OUR PARSER THREW: ${f.error}`);
      } else {
        console.log(`      ours=${f.ours}  markdown-it top-level=${f.miTopLevel}  markdown-it all=${f.miAll}`);
      }
      console.log(`      doc: ${JSON.stringify(f.doc.slice(0, 120))}${f.doc.length > 120 ? "…" : ""}`);
    }
  }

  if (unexpected_fn.length) {
    console.log("\n## UNEXPECTED FALSE-NEGATIVES — markdown-it detects blocks ours misses (coverage gap)\n");
    for (const f of unexpected_fn) {
      console.log(`  [${f.id}]`);
      if (f.notes) console.log(`      notes: ${f.notes}`);
      console.log(`      ours=${f.ours}  markdown-it top-level=${f.miTopLevel}  markdown-it all=${f.miAll}`);
      console.log(`      doc: ${JSON.stringify(f.doc.slice(0, 120))}${f.doc.length > 120 ? "…" : ""}`);
    }
  }

  if (known_fn.length) {
    console.log("\n## KNOWN — off-contract or design-divergence cases (informational; not counted against pass/fail)\n");
    for (const f of known_fn) {
      console.log(`  [${f.id}]`);
      if (f.notes) console.log(`      notes: ${f.notes}`);
      console.log(`      ours=${f.ours}  mi-top-level=${f.miTopLevel}  mi-blockquote-nested=${f.miBlockquoteOnly}`);
    }
  }

  console.log("\n" + line);
  console.log(
    unexpected > 0
      ? `BLOCK-DETECTION RESULT: FAIL — ${unexpected} unexpected divergence(s)`
      : "BLOCK-DETECTION RESULT: PASS — 0 unexpected divergences"
  );
  console.log(line);

  return unexpected > 0 ? 1 : 0;
}
