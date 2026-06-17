// mermaid-node-core — public entry point.
//
// Browser-ESM, zero runtime dependencies. The positioned read core for Mermaid
// flowcharts: every node, edge, subgraph and label carries its real source span,
// so editing/refactoring tooling (rename-id-with-edge-propagation, go-to-def,
// validation) can compute precise text edits.

export { findMermaidBlocks, blockAtLine } from "./parser.js";
