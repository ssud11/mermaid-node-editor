// Cross-surface differential harness (QA-1).
//
// The extension (vscode WorkspaceEdit) and the MCP server (applyEdits) apply the
// SAME `TextEditDesc[]` produced by the SAME vscode-free core (parser + editor)
// through DIFFERENT apply paths. This suite pins the MCP pure path against:
//   (1) hand-verified GOLDEN outputs,
//   (2) an INDEPENDENT reference applier (catches offset/EOL bugs in applyEdits),
//   (3) METAMORPHIC invariants (round-trip / topology / id-substitution),
//   (4) the two most likely real differential bugs: UTF-16 offsets + mixed EOL.
// The host-side WorkspaceEdit path is asserted against the same goldens in the
// integration suite (QA-3), so both surfaces agree transitively.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits } from '../src/apply-edits';
import { renameViaCore, relabelViaCore, renameEdits, edgesOf, applyEditsRef } from './_differential-helpers';

// ---- (1) GOLDEN: pinned expected outputs -------------------------------------
test('differential golden: id rename propagates to every edge reference', () => {
  assert.equal(
    renameViaCore('graph TD\nA[Start] --> B[End]\nB --> A', 'A', 'Z'),
    'graph TD\nZ[Start] --> B[End]\nB --> Z'
  );
});
test('differential golden: rename preserves a pipe edge label', () => {
  assert.equal(renameViaCore('graph TD\nA -->|yes| B', 'A', 'Z'), 'graph TD\nZ -->|yes| B');
});
test('differential golden: relabel preserves bracket shape (no quoting needed)', () => {
  assert.equal(relabelViaCore('graph TD\nA[Start]', 'A', 'New Label'), 'graph TD\nA[New Label]');
});
test('differential golden: relabel auto-quotes a label with syntax chars', () => {
  assert.equal(relabelViaCore('graph TD\nA[x]', 'A', 'a|b'), 'graph TD\nA["a|b"]');
});
test('differential golden: YAML frontmatter config block is untouched by rename', () => {
  const src = '---\nconfig:\n  layout: elk\n---\nflowchart TD\nA --> B';
  assert.equal(renameViaCore(src, 'A', 'Z'), '---\nconfig:\n  layout: elk\n---\nflowchart TD\nZ --> B');
});
test('differential golden: subgraph member rename leaves the subgraph line intact', () => {
  const src = 'graph TD\nsubgraph S [Phase]\nA[x]\nend\nA --> B';
  assert.equal(renameViaCore(src, 'A', 'Z'), 'graph TD\nsubgraph S [Phase]\nZ[x]\nend\nZ --> B');
});

// ---- (2) applyEdits ≡ independent reference applier ---------------------------
test('differential: applyEdits agrees with the independent reference applier', () => {
  const cases: Array<[string, string, string]> = [
    ['graph TD\nA[Start] --> B[End]\nB --> A', 'A', 'Z'],
    ['graph TD\nA -->|yes| B\nB -.-> C', 'B', 'Q'],
    ['---\nconfig:\n  layout: elk\n---\nflowchart TD\nA --> B --> C', 'B', 'BB'],
    ['graph TD\nsubgraph S [P]\nA[x]\nend\nA --> B', 'A', 'Z'],
    ['graph TD\r\nA[x] --> B\nB --> A\r\n', 'A', 'Z'], // mixed EOL
  ];
  for (const [src, o, n] of cases) {
    const edits = renameEdits(src, o, n);
    assert.equal(applyEdits(src, edits), applyEditsRef(src, edits), `mismatch renaming ${o}->${n} in: ${JSON.stringify(src)}`);
  }
});

// ---- (3) METAMORPHIC invariants ----------------------------------------------
test('metamorphic: id rename round-trips to identity', () => {
  for (const [src, id] of [
    ['graph TD\nA[Start] --> B\nB --> A', 'A'],
    ['graph TD\nA -->|y| B\nB --> C', 'B'],
  ] as Array<[string, string]>) {
    const there = renameViaCore(src, id, 'QATMP1');
    assert.equal(renameViaCore(there, 'QATMP1', id), src, `round-trip failed for ${id} in: ${src}`);
  }
});
test('metamorphic: relabel preserves edge topology', () => {
  const src = 'graph TD\nA[Start] -->|go| B[Mid]\nB --> C[End]';
  assert.deepEqual(edgesOf(relabelViaCore(src, 'B', 'Relabelled')), edgesOf(src));
});
test('metamorphic: id rename is pure id-substitution on the edge set', () => {
  const src = 'graph TD\nA --> B\nB --> A\nA --> C';
  const expected = edgesOf(src).map((e) => e.replace(/\bA\b/g, 'Z')).sort();
  assert.deepEqual(edgesOf(renameViaCore(src, 'A', 'Z')), expected);
});

// ---- (4) the two most likely real differential bugs --------------------------
test('UTF-16: a non-BMP (emoji) label survives when another node is renamed', () => {
  const src = 'graph TD\nA["start 🚀 here"] --> B[plain]\nB --> A';
  assert.equal(renameViaCore(src, 'B', 'Q'), 'graph TD\nA["start 🚀 here"] --> Q[plain]\nQ --> A');
});
test('UTF-16: renaming a node whose own label holds an emoji keeps the emoji intact', () => {
  assert.equal(renameViaCore('graph TD\nA["go 🚀"] --> B', 'A', 'Z'), 'graph TD\nZ["go 🚀"] --> B');
});
test('EOL: mixed CRLF/LF — each untouched line keeps its own ending after rename', () => {
  assert.equal(renameViaCore('graph TD\r\nA[x] --> B\nB --> A\r\n', 'A', 'Z'), 'graph TD\r\nZ[x] --> B\nB --> Z\r\n');
});
