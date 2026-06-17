// Build the Peggy grammar -> a standalone ESM parser module (zero runtime dep).
//
// Peggy is a DEV dependency used only here, at build time. The generated
// `src/generated-parser.js` is plain ESM with no imports — it is the artifact
// the library ships and a browser/Next.js consumer bundles. This script is
// Node-only (build tooling); it is NOT part of the runtime surface.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import peggy from "peggy";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const grammarPath = join(root, "grammar", "flowchart.peggy");
const outPath = join(root, "src", "generated-parser.js");

const grammar = readFileSync(grammarPath, "utf8");

const source = peggy.generate(grammar, {
  output: "source",
  format: "es",
  // A named export is friendlier for ESM consumers than a default object.
  // peggy's ES output exports `parse`, `SyntaxError`, etc. as named exports.
});

const banner =
  "// AUTO-GENERATED from grammar/flowchart.peggy by scripts/build-parser.mjs.\n" +
  "// Do NOT edit by hand — edit the .peggy grammar and run `npm run build:parser`.\n" +
  "// Standalone ESM, zero runtime dependencies.\n";

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, banner + source);

console.log(`generated ${outPath} (${source.length} bytes from ${grammar.split("\n").length} grammar lines)`);
