// mermaid-node-core — the positioned read core.
//
// Browser-ESM, zero runtime dependencies, no Node-only APIs. The generated PEG
// parser (`generated-parser.js`) handles ONE flowchart's text; this module is
// the thin envelope that:
//   - locates each Mermaid block (whole `.mmd`, or ```mermaid / ~~~mermaid
//     fences inside markdown), fence-aware so an unterminated fence cannot
//     swallow the rest of the file;
//   - feeds each block's content to the grammar;
//   - applies the block's line offset so every node/edge/subgraph position is
//     ABSOLUTE in the original document;
//   - degrades gracefully on off-contract / invalid input — a block that does
//     not parse is returned `supported:false` with `parseError`, never a throw.

import { parse as parseFlowchart, SyntaxError as PeggySyntaxError } from "./generated-parser.js";

/**
 * @typedef {Object} Node
 * @property {"node"} kind
 * @property {string} id
 * @property {string} label      label content (inside any quotes)
 * @property {string} shape      e.g. "[]", "([])", "{{}}", "" for a bare id
 * @property {string} open       opening bracket token, e.g. "[" or "(["
 * @property {string} close      matching close token
 * @property {string} quote      '"' | "'" | "" — the label quote, if any
 * @property {number} line       0-based absolute line
 * @property {number} startChar  0-based start column of the node text (the id)
 * @property {number} endChar    0-based exclusive-end column of the node text
 * @property {number} labelStart 0-based start column of the label content
 * @property {number} labelEnd   0-based exclusive-end column of the label content
 *
 * @typedef {Object} Edge
 * @property {"edge"} kind
 * @property {string} from
 * @property {string} to
 * @property {string|undefined} label
 * @property {number} line
 * @property {number} startChar
 * @property {number} endChar
 *
 * @typedef {Object} Subgraph
 * @property {"subgraph"} kind
 * @property {string} id
 * @property {string} label
 * @property {boolean} hasId
 * @property {string} quote
 * @property {number} line
 * @property {number} idStart   0-based start column of the id/title token
 * @property {number} idEnd     0-based exclusive-end column of the id/title token
 * @property {string[]} members ids declared/referenced directly inside, in order
 *
 * @typedef {Object} Block
 * @property {number} startLine   line of the ```mermaid fence (0 for whole .mmd)
 * @property {number} endLine     line of the closing fence (last line for .mmd)
 * @property {number} contentStart first content line
 * @property {number} contentEnd   one past the last content line (exclusive)
 * @property {boolean} supported  false for a non-flowchart / unparseable block
 * @property {string} diagramType the diagram type / first content line
 * @property {Node[]} nodes
 * @property {Edge[]} edges
 * @property {Subgraph[]} subgraphs
 * @property {Warning[]} warnings  yellow-lint advisories — the block is still
 *   supported:true; each warning notes a renders-but-off-canonical construct that
 *   was parsed best-effort, skipped block-locally, or split. An empty array means
 *   no advisory. Distinct from `parseError` (a hard parse failure, supported:false).
 * @property {string|undefined} parseError  message when the block didn't parse
 *
 * @typedef {Object} Warning
 * @property {string} code   stable machine code (e.g. "reserved-id", "fanout-split")
 * @property {string} message human-readable advisory
 * @property {number} line   0-based absolute line the advisory points at
 */

const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*(\S*)/;

/**
 * Shift all positions in a parsed flowchart by a line offset so they are
 * absolute in the host document. Columns are unaffected (the grammar sees the
 * block content from column 0 of each line, same as the document).
 */
function applyLineOffset(parsed, lineOffset) {
  if (lineOffset === 0) return parsed;
  for (const n of parsed.nodes) n.line += lineOffset;
  for (const e of parsed.edges) e.line += lineOffset;
  for (const sg of parsed.subgraphs) sg.line += lineOffset;
  // Warnings carry a 0-based line too, so a fenced-block warning points at the
  // absolute document line (not the line within the fence content).
  for (const w of parsed.warnings || []) w.line += lineOffset;
  return parsed;
}

/**
 * Parse one block's content with the grammar. Returns the positioned model, or a
 * graceful "unsupported" stub carrying the parse error (no throw).
 */
function parseBlockContent(content, lineOffset) {
  let parsed;
  try {
    parsed = parseFlowchart(content);
  } catch (err) {
    if (err instanceof PeggySyntaxError || (err && err.name === "SyntaxError")) {
      const firstLine = (content.split(/\r?\n/).find((l) => l.trim() !== "") || "").trim();
      return {
        supported: false,
        diagramType: firstLine,
        nodes: [],
        edges: [],
        subgraphs: [],
        warnings: [],
        parseError: err.message,
      };
    }
    throw err; // a non-grammar error is a real bug — don't swallow it
  }
  // The grammar returns a `warnings` array on a supported block; default it so the
  // field is always present (an empty array = no advisory) before the offset shift.
  if (!parsed.warnings) parsed.warnings = [];
  applyLineOffset(parsed, lineOffset);
  parsed.parseError = undefined;
  return parsed;
}

/**
 * Find every Mermaid flowchart block in a document and parse each.
 *
 * @param {string} text  the document source
 * @param {boolean} isMmd  true for a whole `.mmd`/`.mermaid` file (one block);
 *                         false for markdown (each fenced ```mermaid block)
 * @returns {Block[]}
 */
export function findMermaidBlocks(text, isMmd) {
  const lines = text.split(/\r?\n/);

  if (isMmd) {
    const parsed = parseBlockContent(text, 0);
    return [
      {
        startLine: 0,
        endLine: Math.max(0, lines.length - 1),
        contentStart: 0,
        contentEnd: lines.length,
        ...parsed,
      },
    ];
  }

  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_RE.exec(lines[i]);
    if (!open) {
      i++;
      continue;
    }
    const fenceChar = open[2][0];
    const len = open[2].length;
    const info = open[3].toLowerCase();
    const closeRe = new RegExp("^\\s*" + fenceChar + "{" + len + ",}\\s*$");
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) {
      j++;
    }
    if (j >= lines.length) {
      // Unterminated fence — skip only this opener so it can't capture the file.
      i++;
      continue;
    }
    if (info === "mermaid") {
      const contentStart = i + 1;
      const content = lines.slice(contentStart, j).join("\n");
      const parsed = parseBlockContent(content, contentStart);
      blocks.push({
        startLine: i,
        endLine: j,
        contentStart,
        contentEnd: j,
        ...parsed,
      });
    }
    i = j + 1;
  }
  return blocks;
}

/**
 * Pick the block containing a given line. For `.mmd` the single block is always
 * returned.
 *
 * @param {Block[]} blocks
 * @param {number} line  0-based line in the document
 * @param {boolean} isMmd
 * @returns {Block|undefined}
 */
export function blockAtLine(blocks, line, isMmd) {
  if (isMmd) return blocks[0];
  return blocks.find((b) => line >= b.startLine && line <= b.endLine);
}
