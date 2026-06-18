// Span-invariant property net (shared by run-corpus.mjs AND parser.test.mjs).
//
// WHY this exists: the per-case position checks only proved a span was in-range
// (non-degenerate, inside the line). They did NOT prove the span pointed at the
// RIGHT text — so a span axis could silently degenerate (e.g. a label span
// collapsing to zero width, `labelStart === labelEnd`, which makes a relabel a
// silent no-op) and every model assertion still passed. This net closes that
// gap: a UNIVERSAL per-construct check, run on EVERY valid case, that the
// content the model claims is exactly what its spans slice out of the source.
// The expected slices are COMPUTED from the input + the parsed values (never
// hand-listed per case), so it catches a missed span axis the enumerator never
// thought to assert.
//
// Invariants asserted (per construct, on every valid case):
//
//   NODE
//     - line.slice(labelStart, labelEnd) === label            (label span)
//         The content-exclusive label invariant. This is the universal axis that
//         catches the zero-width-label regression for a hyphen-truncated SHAPED
//         id (`send-email[Send Email]`): the label content is real and editable,
//         so its span must slice to it, never collapse to width 0.
//     - line.slice(startChar, endChar) === <node decl>         (node span)
//         The node-decl span. Per the grammar's content-exclusive contract the
//         span is EITHER the kept id alone (a bare id, or a hyphen-TRUNCATED
//         shaped id — bounded so a span-edit can't overwrite the discarded tail)
//         OR the whole shaped declaration `id + open + <label-in-source> + close`
//         (a non-truncated shaped id). Both legal forms are reconstructed from
//         the parsed values + the label's own source slice, so the check needs no
//         per-case table.
//
//   SUBGRAPH
//     - when hasId:  line.slice(idStart, idEnd) === id         (id span)
//       when !hasId: line.slice(idStart, idEnd) === label
//         The editable id/title span. With an explicit id it points at the id
//         token; for a title-only / bare header (hasId:false) the editable token
//         IS the title (its content-exclusive span) — or, for a header-less
//         `subgraph` line, the `subgraph` keyword (which equals the empty label's
//         fallback) — so the slice equals the label there. This mirrors the
//         grammar's documented idStart/idEnd derivation.
//     - when titleStart present: line.slice(titleStart, titleEnd) === label
//         The content-exclusive title span (present whenever the header has a
//         title), excluding any surrounding quotes/brackets.

// Reconstruct the legal node-decl slice(s) for a node from parsed values + the
// label's own source slice. Returns the set of accepted exact strings for
// line.slice(startChar, endChar). A bare/truncated node accepts only the id; a
// shaped node accepts the full reconstructed declaration (and, for the
// hyphen-truncated shaped case, the bounded id form too — the span is
// deliberately clamped to the kept id there).
function acceptedNodeDeclSlices(n, line) {
  if (!n.shape) return [n.id];
  const q = n.quote || "";
  const labelInSource = line.slice(n.labelStart, n.labelEnd);
  const shaped = n.id + n.open + q + labelInSource + q + n.close;
  // bounded = the kept id alone (hyphen-truncated shaped id: span clamped to id).
  return [shaped, n.id];
}

// Run the span net over one parsed block's nodes + subgraphs against its source
// lines. `fail(msg)` is invoked with a human-readable message on the FIRST
// violation found (the caller decides whether to throw / collect). Returns the
// number of (node + subgraph) constructs checked, so a harness can confirm the
// net actually exercised something.
export function checkSpans(block, lines, fail) {
  let checked = 0;

  for (const n of block.nodes || []) {
    const line = lines[n.line];
    if (line === undefined) {
      fail(`node ${JSON.stringify(n.id)}: line ${n.line} out of range`);
      return checked;
    }
    // label span must slice exactly to the label content (never zero-width here)
    const labelSlice = line.slice(n.labelStart, n.labelEnd);
    if (labelSlice !== n.label) {
      fail(`node ${JSON.stringify(n.id)}: slice(labelStart=${n.labelStart},labelEnd=${n.labelEnd})=${JSON.stringify(labelSlice)} !== label ${JSON.stringify(n.label)}`);
      return checked;
    }
    // node-decl span must slice to one of the legal reconstructed forms
    const declSlice = line.slice(n.startChar, n.endChar);
    const accepted = acceptedNodeDeclSlices(n, line);
    if (!accepted.includes(declSlice)) {
      fail(`node ${JSON.stringify(n.id)}: slice(startChar=${n.startChar},endChar=${n.endChar})=${JSON.stringify(declSlice)} !== node decl (accepted: ${JSON.stringify(accepted)})`);
      return checked;
    }
    checked++;
  }

  for (const sg of block.subgraphs || []) {
    const line = lines[sg.line];
    if (line === undefined) {
      fail(`subgraph ${JSON.stringify(sg.id)}: line ${sg.line} out of range`);
      return checked;
    }
    // editable id/title span: id text when hasId, else the title content (label).
    // Exception: a BARE `subgraph` header (hasId=false, label="") uses the
    // `subgraph` keyword token as the editable span (an intentional fallback to
    // keep idStart < idEnd <= line.length — an OOB zero-width span would be unsafe
    // for write-back). In that case `slice(idStart,idEnd)` is `"subgraph"`, not "",
    // so the standard content-equality check is replaced by the in-bounds/non-
    // degenerate guard (which the existing focused test pins via an exact assertion).
    const idSlice = line.slice(sg.idStart, sg.idEnd);
    if (!sg.hasId && sg.label === "") {
      // Bare subgraph keyword fallback: span must be in-bounds + non-degenerate.
      if (!(sg.idStart >= 0 && sg.idEnd > sg.idStart && sg.idEnd <= line.length)) {
        fail(`subgraph "" (bare): keyword fallback span out of bounds: idStart=${sg.idStart} idEnd=${sg.idEnd} line.length=${line.length}`);
        return checked;
      }
    } else {
      const wantId = sg.hasId ? sg.id : sg.label;
      if (idSlice !== wantId) {
        fail(`subgraph ${JSON.stringify(sg.id)} (hasId=${sg.hasId}): slice(idStart=${sg.idStart},idEnd=${sg.idEnd})=${JSON.stringify(idSlice)} !== ${JSON.stringify(wantId)}`);
        return checked;
      }
    }
    // content-exclusive title span, where a title is present
    if (sg.titleStart !== undefined) {
      const titleSlice = line.slice(sg.titleStart, sg.titleEnd);
      if (titleSlice !== sg.label) {
        fail(`subgraph ${JSON.stringify(sg.id)}: slice(titleStart=${sg.titleStart},titleEnd=${sg.titleEnd})=${JSON.stringify(titleSlice)} !== title ${JSON.stringify(sg.label)}`);
        return checked;
      }
    }
    checked++;
  }

  return checked;
}
