// Property-based differential tier (QA-1b). Generalizes the hand-input
// invariants over randomly generated flowcharts. Seed-pinned → deterministic
// in CI; a failure shrinks to a minimal reproducing diagram + rename op.
import { test } from 'node:test';
import fc from 'fast-check';
import { applyEdits } from '../src/apply-edits';
import { renameEdits, tryRenameViaCore, edgesOf, applyEditsRef } from './_differential-helpers';

// ids: lowercase letter + small int → valid, never a Mermaid keyword / direction.
const LETTERS = 'abcdefghjkmnpqrstuvwxyz'.split('');
const idArb = fc.tuple(fc.constantFrom(...LETTERS), fc.integer({ min: 0, max: 40 })).map(([c, n]) => `${c}${n}`);

const flowArb = fc.uniqueArray(idArb, { minLength: 2, maxLength: 5 }).chain((ids) =>
  fc.record({
    ids: fc.constant(ids),
    edges: fc.array(fc.tuple(fc.constantFrom(...ids), fc.constantFrom(...ids)), { minLength: 1, maxLength: 6 }),
    labeled: fc.array(fc.boolean(), { minLength: ids.length, maxLength: ids.length }),
    pick: fc.integer({ min: 0, max: 1000 }),
  })
);

// Labels use the node INDEX (never the id) so a label never collides with an id.
function build(ids: string[], edges: Array<[string, string]>, labeled: boolean[]): string {
  const lines = ['graph TD'];
  ids.forEach((id, i) => {
    if (labeled[i]) lines.push(`${id}[node ${i}]`);
  });
  for (const [f, t] of edges) lines.push(`${f} --> ${t}`);
  return lines.join('\n');
}

const NEW = 'RENAMED'; // uppercase → cannot collide with a generated id

test('property: applyEdits ≡ reference applier · rename round-trips · edges are pure id-substitution', () => {
  fc.assert(
    fc.property(flowArb, (g) => {
      const ids = g.ids as string[];
      const src = build(ids, g.edges as Array<[string, string]>, g.labeled as boolean[]);
      const oldId = ids[g.pick % ids.length];
      const edits = renameEdits(src, oldId, NEW);
      // (a) the two independent appliers agree on the edited text
      if (applyEdits(src, edits) !== applyEditsRef(src, edits)) return false;
      const renamed = tryRenameViaCore(src, oldId, NEW);
      if (renamed === null) return true; // core declined (id absent from emitted text) — out of scope
      // (b) rename round-trips to identity
      if (tryRenameViaCore(renamed, NEW, oldId) !== src) return false;
      // (c) the edge set is exactly old→new substitution
      const expected = edgesOf(src)
        .map((e) => e.replace(new RegExp(`\\b${oldId}\\b`, 'g'), NEW))
        .sort();
      return JSON.stringify(edgesOf(renamed).sort()) === JSON.stringify(expected);
    }),
    { seed: 4242, numRuns: 300 }
  );
});
