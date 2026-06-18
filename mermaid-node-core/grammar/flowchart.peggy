// ============================================================================
// mermaid-node-core — Mermaid flowchart grammar (the supported input contract, as a spec)
// ============================================================================
//
// This PEG grammar IS the closed specification of the input contract: a Mermaid
// *flowchart* (`graph` / `flowchart`), authored to the conventions the product
// is held to. Re-derived from the contract — node shapes, edge operators,
// subgraphs, labels, comments, frontmatter — not lifted from any prototype.
//
// What it produces: a positioned model. Every node, edge and subgraph carries a
// REAL `{ line, startChar, endChar }` span taken from the matched-rule region
// (peggy's `location()`), 0-based line, 0-based exclusive-end column — never a
// zero-width start. Labels additionally carry `{ labelStart, labelEnd }` (the
// span of the label *content*, inside any quotes), so a relabel writes exactly
// the content slice and leaves brackets/quotes untouched.
//
// Off-contract input: a hyphenated id is truncated at the hyphen
// (matching the documented v1 behavior) and the remainder discarded — so the
// fragment can be left alone on rename; `&` fan-out, over-bracketed shapes,
// reserved-id nodes and unterminated constructs do not match cleanly and either
// produce a structured parse error or are skipped — never a crash or a hang.
//
// Generated to ESM (zero runtime dep) via `peggy --format es`. The runtime
// surface uses no Node-only APIs.
//
// NOTE ON ENVELOPE: this grammar parses ONE flowchart's text (a `.mmd` body or
// the inside of a ```mermaid fence). The markdown-fence / whole-.mmd envelope is
// a thin string pre-processor in `src/parser.js` that locates each block, then
// feeds its content here with a line offset applied to the returned positions.
// Keeping the envelope out of the grammar keeps the grammar a pure flowchart
// spec and avoids the "unterminated fence swallows the file" class of bug.
// ============================================================================

{{
  // --- warnings (yellow-lint advisories) ----------------------------------
  //
  // A warning is `{ code, message, line }` (0-based line within the block; the
  // envelope in src/parser.js shifts it to an absolute document line). Warnings
  // are NOT collected in a shared mutable array — PEG backtracking would leave
  // spurious entries from speculative paths that were later discarded. Instead a
  // warning rides on the MODEL OBJECT (a node/edge's `_warn`, or a statement
  // line's `warnings[]`) the action returns; only COMMITTED results reach the
  // `Body` assembly, which harvests + de-dupes them. A backtracked object never
  // enters the committed list, so its warning never surfaces. (Verified: an
  // action that warns then backtracks leaves no warning when warnings are
  // model-attached, but DOES when pushed to a shared array.)
  function warn(code, message, loc) {
    return { code, message, line: loc.start.line - 1 };
  }

  // A FATAL warning marks a construct that REAL Mermaid REJECTS (a parse error,
  // fatal to the WHOLE diagram). Per the contract the block keeps a best-effort
  // model for editing but is reported `supported:false` with a clear "won't render"
  // reason — NEVER a false `supported:true`. The `fatal` + `reason` riders survive
  // the warning-harvest (Body.addWarn strips only `_dedup`); the Document action
  // scans the committed warnings, and if any is fatal, sets supported:false +
  // parseError. This is distinct from an advisory (yellow-lint) warning on a form
  // Mermaid RENDERS — those keep supported:true.
  function fatalWarn(code, message, reason, loc) {
    return { code, message, line: loc.start.line - 1, fatal: true, reason };
  }

  // The "won't render" reason for a PAREN-form subgraph title (Mermaid rejects it).
  function subgraphParenReason() {
    return "a parenthesized subgraph title `(...)` — won't render in Mermaid (use `[title]` or a quoted title)";
  }

  // A reserved-keyword-as-node FATAL warning. Mermaid parse-errors the whole diagram
  // when a reserved keyword is used as a node id, so this is supported:false.
  function fatalReservedWarn(kw, loc) {
    const w = fatalWarn(
      "reserved-id",
      `"${kw}" is a reserved keyword and cannot be a node id`,
      `"${kw}" is a reserved Mermaid keyword used as a node id — won't render in Mermaid`,
      loc,
    );
    w._dedup = kw; // case-sensitive token (the exact reserved lowercase form)
    return w;
  }

  // A `reserved-id` warning that rides the offending keyword (lower-cased) as its
  // `_dedup` distinguisher, so two DISTINCT reserved keywords skipped on ONE line
  // (e.g. a `;`-chain `end[X]; style[Y]`) each surface — the bare code|line key
  // would collapse them to one. A SAME keyword repeated on the line (`end[X];
  // end[Y]`) still collapses (same key), matching the edge-endpoint reserved-id
  // path which already rides `_dedup`.
  function reservedSkipWarn(kw, loc) {
    const w = warn("reserved-id", `"${kw}" is a reserved keyword and cannot be a node id; this node is skipped`, loc);
    w._dedup = kw.toLowerCase();
    return w;
  }

  // --- model constructors -------------------------------------------------

  // 0-based line + 0-based exclusive-end column from a peggy location().
  function span(loc) {
    return {
      line: loc.start.line - 1,
      startChar: loc.start.column - 1,
      endChar: loc.end.column - 1,
    };
  }

  function makeNode(id, shapeInfo, loc, shapeLoc) {
    const s = span(loc);
    // The node span must end exactly at the kept content, NEVER spanning a
    // discarded off-contract hyphen tail (`receive-order` → kept id `receive`;
    // `send-email[Label]` → kept id `send`). This upholds the content-exclusive
    // invariant so a span-rename / relabel targets only the kept text and leaves
    // the discarded tail untouched — a span that ran past it would let an edit
    // silently overwrite `-order`/`-email`.
    //
    //   - BARE id (no shape): the node text IS the kept id, so endChar =
    //     startChar + id.length (`slice(startChar,endChar) === id`).
    //   - SHAPED id: the node text is `id` + shape. For a NON-truncated id the
    //     kept id sits flush against the shape opener, so endChar = the matched
    //     rule end (the whole `A[Start]`). For a hyphen-TRUNCATED shaped id the
    //     discarded tail sits BETWEEN the kept id and the shape (`send` ┃-email┃
    //     `[Label]`), so a single contiguous span can't cover both the kept id
    //     and the shape without also covering the discarded tail. We bound the
    //     span to the kept id alone (like the bare arm) — the off-contract
    //     `-email[Label]` remainder is left for the consumer to warn on, and
    //     `slice(startChar,endChar) === id` holds for the truncated case too,
    //     matching the bare-truncated arm the corpus already certifies. The
    //     LABEL span (labelStart/labelEnd) is a SEPARATE concern: even when the
    //     node span is bounded to the kept id, the bracketed label content is
    //     real and editable, so the label span keeps pointing at that content
    //     (`slice(labelStart,labelEnd) === label`) rather than being zeroed.
    //
    // Truncation is detected positionally: shapeLoc is captured right AFTER the
    // consumed id (incl. any discarded hyphen tail) and right BEFORE the shape
    // opener, so a gap between `startChar + id.length` and the shape-open column
    // means the id was truncated.
    let endChar;
    let labelStart;
    let labelEnd;
    if (!shapeInfo) {
      endChar = s.startChar + id.length;
      labelStart = s.startChar;
      labelEnd = endChar;
    } else {
      const keptIdEnd = s.startChar + id.length;
      const shapeOpenCol = shapeLoc ? shapeLoc.start.column - 1 : keptIdEnd;
      const truncated = shapeOpenCol > keptIdEnd;
      if (truncated) {
        // Hyphen-truncated shaped id — bound the NODE span to the kept id (like
        // the bare arm), so a span-rename can't overwrite the discarded `-email`
        // tail. But the LABEL span is INDEPENDENT of the node span: the shape's
        // bracketed content is still present and editable, so the label span must
        // point at that real in-bracket content (`shapeInfo` carries it, captured
        // via HERE against the source columns inside the brackets — unaffected by
        // the truncation). Zeroing it (labelStart === labelEnd) made a relabel a
        // silent no-op (an empty edit). Keep the node span tight to the kept id,
        // but let labelStart/labelEnd slice to the real label content so
        // `source.slice(labelStart,labelEnd) === label` holds for the shaped-
        // truncated case across every shape.
        endChar = keptIdEnd;
        labelStart = shapeInfo.labelStart;
        labelEnd = shapeInfo.labelEnd;
      } else {
        endChar = s.endChar;
        labelStart = shapeInfo.labelStart;
        labelEnd = shapeInfo.labelEnd;
      }
    }
    const node = {
      kind: "node",
      id,
      label: shapeInfo ? shapeInfo.label : id,
      shape: shapeInfo ? shapeInfo.shape : "",
      open: shapeInfo ? shapeInfo.open : "",
      close: shapeInfo ? shapeInfo.close : "",
      quote: shapeInfo ? shapeInfo.quote : "",
      line: s.line,
      startChar: s.startChar,
      endChar,
      labelStart,
      labelEnd,
    };
    // v1.6 #3 — a shape REAL Mermaid rejects (empty label / unquoted bracket in label)
    // rides a FATAL warning on the node, so Body harvests it and the Document reports
    // the block supported:false. The node itself is still emitted (best-effort model).
    if (shapeInfo && shapeInfo.fatalReason) {
      node._warn = fatalWarn("invalid-label", shapeInfo.fatalReason, shapeInfo.fatalReason, loc);
    }
    return node;
  }

  // ADDITIVE edge metadata (head / stroke / bidirectional / length) is carried
  // alongside the long-standing { from, to, label } shape. `meta` is the Link
  // rule's descriptor; the values mirror REAL Mermaid v11's FlowDB.getEdges()
  // (`type` → head, `stroke`, `length`):
  //   - head:   'arrow' (a `>` head, incl. Mermaid's "leading o/x is decorative
  //             when a `>` is present" rule), 'open' (no head), 'circle' (`o`),
  //             'cross' (`x').
  //   - stroke: 'solid' (`--`), 'thick' (`==`), 'dotted' (`-.-`), 'invisible' (`~`).
  //   - bidirectional: a head on BOTH ends (`<-->`, `o--o`, `x--x` + thick/dotted).
  //   - length: Mermaid's shaft-length index (`-->`=1, `--->`=2, …) — see linkLen.
  // The fields are OPTIONAL on the public shape (defaulted here) so existing
  // from/to/label/reversed consumers are untouched; meta may be omitted entirely.
  function makeEdge(from, to, label, loc, meta) {
    const s = span(loc);
    const m = meta || {};
    return {
      kind: "edge",
      from,
      to,
      label: (label === null || label === undefined) ? undefined : label,
      head: m.head !== undefined ? m.head : "arrow",
      stroke: m.stroke !== undefined ? m.stroke : "solid",
      bidirectional: m.bidirectional === true,
      length: m.length !== undefined ? m.length : 1,
      line: s.line,
      startChar: s.startChar,
      endChar: s.endChar,
    };
  }

  // Mermaid's shaft-length index, derived from the operator text (oracle-pinned
  // against FlowDB.getEdges().length in mermaid@11.15.0):
  //   dash  : headed `-->`(1) `--->`(2)  → (#dash − 1); open `---`(1) `----`(2) → (#dash − 2)
  //   thick : headed `==>`(1) `===>`(2)  → (#eq  − 1); open `===`(1) `====`(2) → (#eq  − 2)
  //   dotted: `-.->`(1) `-..->`(2)       → (#dot)     ; open `-.-`(1) `-..-`(2) → (#dot)
  //   invis : `~~~`(1) `~~~~`(2)         → (#tilde − 2)
  // `headed` = there is a terminal head char (`>`/`x`/`o`), which shifts the
  // dash/thick open-vs-headed offset by one. Floors at 1 (Mermaid's minimum).
  // `t` is the matched operator text — peggy's `text()` is only in scope inside a
  // rule ACTION, not in this init-block helper, so the caller passes it in.
  function linkLen(t, stroke, headed) {
    if (stroke === "dotted") return Math.max(1, (t.match(/\./g) || []).length);
    if (stroke === "invisible") return Math.max(1, (t.match(/~/g) || []).length - 2);
    if (stroke === "thick") return Math.max(1, (t.match(/=/g) || []).length - (headed ? 1 : 2));
    // solid (dash)
    return Math.max(1, (t.match(/-/g) || []).length - (headed ? 1 : 2));
  }

  // Length for a LEADING-head solid arrow (`o-->`/`x-->`). Oracle: a leading o/x
  // SHIFTS Mermaid's length +1 vs the bare arrow — `o-->`=len2 (vs `-->`=len1),
  // `o--->`=len3 — so length is exactly the dash count (not dash-1). Floors at 1.
  function leadingLen(t) {
    return Math.max(1, (t.match(/-/g) || []).length);
  }

  // A Link descriptor with metadata. `extra` may set inlineDash/inlineDot/unsupported.
  function link(label, reversed, head, stroke, bidirectional, length, extra) {
    const d = {
      label: label === undefined ? undefined : label,
      reversed: !!reversed,
      head,
      stroke,
      bidirectional: !!bidirectional,
      length,
    };
    if (extra) Object.assign(d, extra);
    return d;
  }

  // The set of flowchart keywords that may never be a node id, because REAL Mermaid
  // (FlowDB) parse-ERRORS the whole diagram when one is used as a shaped node id.
  // Verified directly against mermaid@11.15.0's flow grammar (`<kw>[X]` rejected):
  // only these eight. CASE-SENSITIVE — Mermaid reserves the EXACT lowercase tokens,
  // so `End`/`STYLE`/`Graph` are ORDINARY ids (Mermaid keeps them as normal nodes),
  // matching the contract ("reserved keywords are case-sensitive").
  //
  // NOT reserved (Mermaid renders `<kw>[X]` as a normal node — oracle-confirmed):
  //   direction, click, default, href, call, link, accTitle, accDescr.
  // These still have their own line-leading directive rules (DirectionStmt /
  // DirectiveStmt) for the `direction LR` / `click A "url"` statement forms; only
  // their use as a NODE id is unreserved here.
  const RESERVED = new Set([
    "graph", "flowchart", "subgraph", "end",
    "class", "classDef", "style", "linkStyle",
  ]);
  function isReserved(id) {
    return RESERVED.has(id); // case-SENSITIVE: only the exact lowercase Mermaid token
  }

  // Build a shape descriptor from open/close tokens + a label result. `l` is the
  // { value, quote, labelStart, labelEnd } from a per-shape label / AsymLabel rule.
  //
  // v1.6 #3 — detect the two label forms REAL Mermaid REJECTS (oracle-confirmed parse
  // errors), recording a `fatalReason` so the node carries a fatal warning (the block
  // is reported supported:false; the best-effort model is still exposed for editing):
  //   - EMPTY label: `A[]` / `A[""]` → reject (but `A[ ]`, a single space, RENDERS —
  //     so the trigger is an EMPTY value, not a whitespace-only one);
  //   - UNQUOTED label containing a BRACKET char `()[]{}`: `A[Order (Pending)]`,
  //     `A(read [x])` → reject. Other punctuation (`<`,`&`,`:`,`/`,`-`,`.`) renders, so
  //     ONLY bracket chars trip it. A QUOTED label may contain anything (it renders).
  function shape(open, close, l) {
    let fatalReason;
    if (l.value === "") {
      fatalReason = `empty ${open}${close} label — won't render in Mermaid`;
    } else if (l.quote === "" && /[()\[\]{}]/.test(l.value)) {
      fatalReason = `unquoted bracket character inside a ${open}${close} label — won't render in Mermaid (quote the label)`;
    }
    return {
      open,
      close,
      shape: open + close,
      label: l.value,
      quote: l.quote,
      labelStart: l.labelStart,
      labelEnd: l.labelEnd,
      fatalReason,
    };
  }

  // Label content span helpers. `startLoc` is the HERE-captured location at the
  // first character of the content; `endLoc` is location() AFTER the content
  // (and any close quote) was consumed, so we subtract the trailing quote.
  function labelSpan(value, quote, startLoc, endLoc) {
    const start = startLoc.start.column - 1 + (quote ? 1 : 0);
    return {
      value,
      quote,
      labelStart: start,
      labelEnd: start + value.length,
    };
  }
  // A raw (unquoted) run — its span is exactly the consumed text.
  function labelSpanRaw(value, quote, startLoc) {
    const start = startLoc.start.column - 1;
    return {
      value,
      quote,
      labelStart: start,
      labelEnd: start + value.length,
    };
  }

  // Subgraph-title content span helpers. Both return { titleStart, titleEnd }
  // such that source.slice(titleStart, titleEnd) === the title value (the same
  // content-exclusive invariant the node label spans uphold).
  //
  // contentSpan: `cLoc` is the HERE location at the opening quote; the content
  // begins `leading` chars after it (1 for the single opening quote).
  function contentSpan(value, cLoc, leading) {
    const start = cLoc.start.column - 1 + (leading === undefined ? 1 : leading);
    return { titleStart: start, titleEnd: start + value.length };
  }
  // trimmedSpan: an unquoted bracketed run that gets .trim()'d — `cLoc` is the
  // HERE location at the first RAW char; advance past the leading whitespace that
  // trim removed so the span aligns with the trimmed value.
  function trimmedSpan(raw, cLoc) {
    const lead = raw.length - raw.replace(/^[ \t]+/, "").length;
    const trimmed = raw.trim();
    const start = cLoc.start.column - 1 + lead;
    return { titleStart: start, titleEnd: start + trimmed.length };
  }
}}

// ─── Entry point ────────────────────────────────────────────────────────────
// A single flowchart: optional frontmatter, the diagram header, then a body of
// statement lines. The body is a flat list of model items (nodes/edges) plus a
// tree of subgraphs assembled in the action.

Document
  = _nl Frontmatter? _nl header:DiagramHeader body:Body EOF
  {
    // A FATAL warning marks a construct REAL Mermaid REJECTS (a parse error fatal to
    // the whole diagram). Per the contract: such a block keeps its best-effort
    // model (for editing) but is reported supported:false + a clear "won't render"
    // reason — never a false supported:true. The `fatal`/`reason` riders are stripped
    // from the public warning shape here so {code,message,line} stays clean; the
    // honest signal is carried on the block via supported + parseError.
    let supported = true;
    let parseError;
    const publicWarnings = [];
    for (const w of body.warnings) {
      if (w.fatal) {
        supported = false;
        if (parseError === undefined && w.reason) parseError = w.reason;
      }
      const { fatal, reason, ...pub } = w;
      publicWarnings.push(pub);
    }
    return {
      supported,
      parseError,
      diagramType: header.raw,
      keyword: header.keyword,
      direction: header.direction,
      nodes: body.nodes,
      edges: body.edges,
      subgraphs: body.subgraphs,
      warnings: publicWarnings,
    };
  }

// YAML-ish frontmatter Mermaid allows before the keyword (title:/config:/id:).
// Consumed and discarded; the position offset is handled by counting lines, so
// node/edge lines remain absolute within the block.
Frontmatter
  = "---" RestOfLine NL (!("---" RestOfLine (NL / EOF)) RestOfLine NL)* "---" RestOfLine (NL / EOF)

DiagramHeader
  = kw:("flowchart" / "graph") dir:(WS d:Direction { return d; })? Sp InlineComment? (NL / EOF)
  // `text()` includes the consumed trailing newline, so the comment-strip regex
  // needs the `m` flag for `$` to anchor at the END OF LINE (before that `\n`) —
  // without it `$` only matches the very end of the string, the inline comment is
  // not at `$`, and a same-line `%% note` leaks into `diagramType` (`graph TD %% note`).
  { return { keyword: kw, direction: dir, raw: text().replace(/\s*%%.*$/m, "").trim() }; }

Direction = ("TD" / "TB" / "BT" / "LR" / "RL") { return text(); }

// ─── Body assembly (nodes + edges + subgraph tree) ───────────────────────────
// Each StmtLine yields { nodes, edges, subgraphs }; we merge them, threading a
// `members` list onto each subgraph from the ids declared/referenced inside it.

Body
  = lines:StmtLine*
  {
    const nodes = [];
    const edges = [];
    const subgraphs = [];
    const warnings = [];
    const seenWarn = new Set();
    // Harvest a warning, de-duping on (code|line) so a construct that warns once
    // per matched line can't double-report; strip any `_warn` rider off the model
    // object so it never leaks into the public node/edge shape.
    const addWarn = (w) => {
      if (!w) return;
      const key = w.code + "@" + w.line + (w._dedup !== undefined ? "@" + w._dedup : "");
      if (w._dedup !== undefined) delete w._dedup;
      if (seenWarn.has(key)) return;
      seenWarn.add(key);
      warnings.push(w);
    };
    const take = (item) => {
      if (item && item._warn) { addWarn(item._warn); delete item._warn; }
      return item;
    };
    for (const ln of lines) {
      if (!ln) continue;
      for (const n of ln.nodes) nodes.push(take(n));
      for (const e of ln.edges) edges.push(take(e));
      for (const sg of ln.subgraphs) subgraphs.push(take(sg));
      // A statement line may also carry line-level warnings not tied to one item
      // (e.g. a reserved-keyword node skipped block-locally — no model object).
      if (ln.warnings) for (const w of ln.warnings) addWarn(w);
    }
    return { nodes, edges, subgraphs, warnings };
  }

// A statement line. A Subgraph is a MULTI-line construct that consumes its own
// terminator (the closing `end` line), so it is matched first and on its own —
// NOT wrapped in the single-line NL terminator. Every other alternative consumes
// at least its trailing NL (or, for the final line, real content before EOF), so
// a `StmtLine*` loop can never spin on a zero-width match.
StmtLine
  = sg:Subgraph                              { return sg; }   // self-terminating, multi-line
  / DirectionStmt                            { return null; }    // `direction LR` — consumed + ignored
  / DirectiveStmt                            { return null; }    // style/click/classDef/... — consumed + ignored
  / content:SingleLineBody NL                { return content; } // a line ending in a newline
  / content:SingleLineBody EOF               { return content; } // the final line, no NL
  / r:ReservedNodeStmt                       { return r; }       // standalone reserved-keyword node — dropped + warned, surroundings survive
  / Sp InlineComment? NL                     { return null; }    // blank / comment-only line
  / Sp InlineComment EOF                     { return null; }    // final comment-only line, no NL
  / WS EOF                                   { return null; }    // final whitespace-only line, no NL

// A standalone reserved-keyword node on its own line — `end[Node]`, `style(x)`,
// `graph` (bare), etc. A reserved keyword may never be a node id (the input
// contract), so EdgeChain (which drops a reserved ENDPOINT but keeps the edge's
// other end) and NodeStmt (which declines a reserved id) both leave such a line
// unconsumed — and an unconsumed line fails the WHOLE block via Document's EOF,
// SILENTLY LOSING every valid statement around it. This recovery alternative
// consumes-and-DROPS the line (returns null → contributes no node/edge), the same
// skip-and-survive intent EdgeChain already applies to a reserved edge endpoint,
// so the surrounding valid statements parse. It is the LAST content alternative
// (after EdgeChain/NodeStmt have declined), so a real edge that merely begins with
// a reserved keyword (`end --> A`, dropped to an empty-but-surviving edge by
// EdgeChain) is matched there first and never reaches here. The `!IdChar` boundary
// keeps a real node whose id only STARTS with a keyword (`ending[X]`, `classy`,
// `styles --> A`) out of this rule — those are valid ids and stay live.
//
// CRITICAL ORDERING WITH `end`: a BARE `end` is the SUBGRAPH terminator. Inside a
// subgraph body (`StmtLine*` followed by `Sp "end"`), recovering a bare `end` here
// would EAT the closing `end` and the subgraph would never terminate. So bare `end`
// is EXCLUDED from recovery — it is left for the Subgraph rule's terminator (and a
// stray bare `end` with no open subgraph falls through to an honest whole-block
// warn, unchanged from before). A SHAPED `end[X]` is unambiguous (the terminator is
// always bare `end`), so it IS recovered. Every OTHER reserved keyword is recovered
// bare or shaped.
//
// Generalizes the reserved-keyword family: {every reserved keyword except bare
// `end`} × {standalone bare / standalone shaped} skip-and-preserve-surroundings
// here, while {reserved as an edge endpoint} drops-the-edge-keep-surroundings in
// EdgeChain.
//
// CASE-SENSITIVE (v1.6): the keywords match the EXACT lowercase Mermaid token only.
// Mermaid parse-ERRORS the whole diagram for a lowercase-reserved id (`style[X]` →
// Parse error), so this is a Mermaid-REJECTS form: per the contract the line is
// matched, a best-effort skip is recorded, and a FATAL `reserved-id` warning is
// attached so the envelope marks the WHOLE block `supported:false` (a Mermaid parse
// error is fatal to the whole diagram). A capitalized/mixed-case variant (`End[X]`,
// `STYLE[x]`) is NOT reserved — it falls through to NodeStmt and becomes a normal
// node, exactly as Mermaid renders it.
ReservedNodeStmt
  = Sp kw:"end" !IdChar NodeShape Sp InlineComment? (NL / EOF)   // shaped `end[X]` only (bare `end` = subgraph terminator)
    { return { nodes: [], edges: [], subgraphs: [], warnings: [fatalReservedWarn(kw, location())] }; }
  / Sp kw:NonEndReservedKeyword !IdChar NodeShape? Sp InlineComment? (NL / EOF)
    { return { nodes: [], edges: [], subgraphs: [], warnings: [fatalReservedWarn(kw, location())] }; }

NonEndReservedKeyword
  = "graph" / "flowchart" / "subgraph"
  / "classDef" / "class" / "linkStyle" / "style"

// A per-(sub)graph layout directive — `direction LR` / `direction TD` etc. It
// carries no node/edge to model, so (like a comment) it is consumed and ignored.
// `direction` is in the RESERVED set but otherwise has no producing rule; without
// this, a standard mixed-orientation diagram fails the WHOLE block. Matched at the
// statement-line level so it is recognized both top-level and inside a subgraph
// body. Requires a real direction token (so a node literally named `direction`
// without a following direction keyword still falls through to NodeStmt).
DirectionStmt
  = Sp "direction" WS Direction Sp InlineComment? (NL / EOF)

// A non-node/edge flowchart statement line — styling, interaction, and
// accessibility declarations. Each begins with a reserved keyword but produces no
// node/edge to model, so (like `direction` and comments) the whole line is
// consumed and ignored — the real nodes/edges around it survive instead of the
// keyword token falling through to EdgeChain and aborting the WHOLE block.
//
// Covered keywords (the complete set of line-leading flowchart directives beyond
// `direction`/`subgraph`/`end`/`graph`/`flowchart`):
//   style / class / classDef / linkStyle / click   — styling + interaction
//   accTitle / accDescr                             — accessibility
// `accDescr` additionally has a brace-block form (`accDescr { … }`) that spans
// multiple lines, so that form consumes through its closing `}` line.
//
// The keyword must be a WHOLE token: a `!IdChar` boundary after it prevents
// consuming a real node whose id merely starts with these letters (e.g.
// `styleA[x]`, `classroom --> X`) — those still fall through to NodeStmt/EdgeChain.
// `default` is NOT line-leading (it only appears as `classDef default`, consumed
// by the classDef branch), so it needs no separate rule.
// The single-line form additionally requires the keyword NOT be immediately
// followed by a shape-opening bracket (`!OpenBracket`). That position-precise guard
// distinguishes a real directive from a reserved keyword being (off-contract) used
// as a SHAPED node id at the head of an edge statement: `style[L] --> B` is `style`
// with a `[L]` shape, so the directive rule declines and the line falls through to
// EdgeChain — where the reserved-id source is dropped per the documented
// reserved-keyword limitation, but the same-line destination `B` SURVIVES instead
// of vanishing. A genuine directive (`style A fill:red`, `classDef x ...`,
// `click A "url--x"`, `accTitle: a -- b`) is keyword + space/`:`, NEVER a bracket,
// so it still matches and `RestOfLine` consumes the whole line — any `--`/`==>`/`===`
// inside the directive's VALUE is now irrelevant (it's just opaque rest-of-line text).
DirectiveStmt
  = Sp "accDescr" !IdChar Sp "{" (!"}" .)* "}" RestOfLine (NL / EOF)  // multi-line block form, tried first
  / Sp DirectiveKeyword !IdChar !OpenBracket RestOfLine (NL / EOF)

DirectiveKeyword
  = "classDef" / "class" / "linkStyle" / "style" / "click" / "accTitle" / "accDescr"

// A single-line statement's payload (no terminator). Requires real content so the
// final-line (EOF) alternative is never a zero-width match.
//
// v1.6 #3 — a trailing inline `%%` comment AFTER statement content on the same line is
// a Mermaid-REJECTS form (oracle: `A --> B %% c` / `A[x] %% c` → Parse error; an
// OWN-LINE `%% c`, a TRAILING comment-only line, and `%%` at EOF all RENDER and are
// handled by the separate comment-only StmtLine alternatives). The `cLoc:HERE` captures
// the comment's position; a fatal warning is attached so the block is supported:false
// while the statement's best-effort nodes/edges stay in the model.
SingleLineBody
  = Sp content:StmtContent Sp cmt:(cLoc:HERE InlineComment { return cLoc; })?
  {
    if (cmt) {
      content.warnings = [...(content.warnings || []), fatalWarn(
        "inline-comment",
        "an inline `%%` comment after content on the same line — won't render in Mermaid (put the comment on its own line)",
        "an inline `%%` comment after content on the same line — won't render in Mermaid",
        cmt,
      )];
    }
    return content;
  }

StmtContent
  = SemicolonStmts
  / s:SingleStmt Sp ";"? { return s; }   // a single statement, optional trailing `;`

// `A --> B ; C --> D` — split on a top-level `;` (a `;` inside a pipe/inline
// label can't appear here because labels are matched as opaque runs). A trailing
// `;` with nothing after it is allowed (`A --> B;`).
SemicolonStmts
  = first:SingleStmt rest:(Sp ";" Sp s:SingleStmt { return s; })+ Sp ";"?
  {
    const acc = { nodes: [...first.nodes], edges: [...first.edges], subgraphs: [], warnings: [...(first.warnings || [])] };
    for (const s of rest) {
      acc.nodes.push(...s.nodes);
      acc.edges.push(...s.edges);
      if (s.warnings) acc.warnings.push(...s.warnings);
    }
    return acc;
  }

SingleStmt
  = EdgeChain
  / NodeStmt
  / ReservedNodeSeg

// A reserved-keyword shaped node as ONE SEGMENT of a `;` chain (or a bare single
// statement that isn't an edge/node). Mirrors the own-line `ReservedNodeStmt` arms
// but WITHOUT the trailing (NL / EOF) terminator (a `;` chain segment is delimited
// by `;`, not a newline), so a reserved shaped node inside `A --> B; end[X]; C --> D`
// is dropped + reserved-id-warned BLOCK-LOCALLY instead of hard-failing the whole
// chain. Tried only after EdgeChain + NodeStmt decline (a real node/edge is claimed
// there first). Shaped `end[X]` only — bare `end` stays the subgraph terminator and
// is excluded here so it never gets swallowed as a chain segment.
ReservedNodeSeg
  = kw:"end" !IdChar NodeShape
    { return { nodes: [], edges: [], subgraphs: [], warnings: [fatalReservedWarn(kw, location())] }; }
  / kw:NonEndReservedKeyword !IdChar NodeShape?
    { return { nodes: [], edges: [], subgraphs: [], warnings: [fatalReservedWarn(kw, location())] }; }

// ─── Subgraph ────────────────────────────────────────────────────────────────
// `subgraph [id] [title]` ... `end`. The header carries its own positions (for
// editing the title); the body recurses through StmtLine, and the inner items
// (nodes/edges/nested subgraphs) are both returned up AND recorded as members.

Subgraph
  = Sp kwLoc:HERE "subgraph" hdrLoc:HERE header:(WS h:SubgraphHeader { return h; })? Sp InlineComment? NL
    body:StmtLine*
    Sp "end" !IdChar Sp InlineComment? (NL / EOF)
  {
    const nodes = [];
    const edges = [];
    const subgraphs = [];
    const members = [];
    // Line-level warnings emitted INSIDE the subgraph body (e.g. a reserved-keyword
    // node skipped block-locally — no model object to ride on). Item-level `_warn`
    // riders on inner nodes/edges bubble up untouched on the pushed objects and are
    // harvested by the OUTER `Body.take()`; only these non-item line warnings need
    // forwarding, exposed as `warnings` on this subgraph's StmtLine result.
    const innerWarnings = [];
    const seenMember = new Set();
    const addMember = (id) => {
      if (!seenMember.has(id)) { seenMember.add(id); members.push(id); }
    };
    for (const ln of body) {
      if (!ln) continue;
      // A line that yielded nested subgraph(s) contributes ONLY the nested
      // subgraph id(s) as direct members of THIS subgraph — the nested nodes are
      // members of the nested subgraph, not this one. (They still bubble up into
      // `nodes` so the block-level node list is complete.)
      const isNested = ln.subgraphs.length > 0;
      for (const n of ln.nodes) {
        nodes.push(n);
        if (!isNested) addMember(n.id);
      }
      for (const e of ln.edges) {
        edges.push(e);
        if (!isNested) { addMember(e.from); addMember(e.to); }
      }
      for (const sg of ln.subgraphs) {
        subgraphs.push(sg);
        // The directly-nested subgraph is the FIRST in the returned list (the
        // Subgraph action prepends itself before its own descendants).
      }
      if (isNested) addMember(ln.subgraphs[0].id);
      if (ln.warnings) for (const w of ln.warnings) innerWarnings.push(w);
    }
    const h = header || { id: null, title: null, idLoc: hdrLoc, idText: "", titleSpan: null };
    const idSpan = span(h.idLoc);
    const id = h.id != null ? h.id : (h.title != null ? h.title : "");
    const hasId = h.id != null;
    // The span of the `subgraph` KEYWORD token itself (`{ start: kwLoc, end: hdrLoc }`).
    // Used as the editable-span fallback for a BARE `subgraph` header (no id AND no
    // title): h.idLoc there is the zero-width HERE captured one past the keyword, so
    // its span is zero-width and one column past end-of-line (OOB). Pointing the span
    // at the keyword token instead keeps idStart < idEnd <= line.length.
    const kwSpan = span({ start: kwLoc.start, end: hdrLoc.start });
    // The EDITABLE id/title span. With an explicit id, idStart/idEnd point at the
    // id token. Without an id (title-only header) the editable token IS the title,
    // so idStart/idEnd use the title's CONTENT-exclusive span (so the span slices
    // to the label, matching the node labelStart/labelEnd invariant — never the
    // surrounding quotes/brackets). With NEITHER id NOR title (a bare `subgraph`
    // line) there is no editable token, so the span is clamped to the keyword.
    const idStart = (!hasId && h.titleSpan) ? h.titleSpan.titleStart
                  : (!hasId && h.title == null) ? kwSpan.startChar
                  : idSpan.startChar;
    const idEnd = (!hasId && h.titleSpan) ? h.titleSpan.titleEnd
                : (!hasId && h.title == null) ? kwSpan.endChar
                : idSpan.endChar;
    const sgNode = {
      kind: "subgraph",
      id,
      label: h.title != null ? h.title : (h.id != null ? h.id : ""),
      hasId,
      quote: h.quote || "",
      line: idSpan.line,
      idStart,
      idEnd,
      members,
    };
    // A positioned, content-exclusive span for the title content. ALWAYS emitted so a
    // consumer can `slice(titleStart, titleEnd)` unconditionally and get the editable
    // label content — never undefined (which an unguarded slice would turn into
    // full-line garbage) and never out of sync with `label`. Three sources, all
    // upholding `source.slice(titleStart, titleEnd) === label`:
    //   - explicit title  → the content-exclusive title span (excludes quotes/brackets);
    //   - id, no title    → the id span (label === id there, so the slice === label);
    //   - no id, no title → a ZERO-WIDTH span at the editable-token start (label is "",
    //                       so the slice must be ""; the id span there points at the
    //                       `subgraph` keyword, which would NOT slice to "").
    if (h.titleSpan) {
      sgNode.titleStart = h.titleSpan.titleStart;
      sgNode.titleEnd = h.titleSpan.titleEnd;
    } else if (sgNode.label.length > 0) {
      // hasId with no title (or a free-text title that landed in idStart/idEnd): the
      // editable id/title span IS the label span here.
      sgNode.titleStart = idStart;
      sgNode.titleEnd = idEnd;
    } else {
      // Bare `subgraph` header (no id, no title): empty label → a zero-width span at
      // the editable-token start so the slice is exactly "".
      sgNode.titleStart = idStart;
      sgNode.titleEnd = idStart;
    }
    // A reserved keyword used as a subgraph id (`subgraph graph[Title]`,
    // `subgraph end[Title]`) RENDERS in real Mermaid, so per the renders-it rule we
    // KEEP the subgraph and attach a yellow-lint rather than hard-failing or
    // silently accepting. Any edge that REFERENCES this reserved id is dropped by
    // EdgeChain with its own `reserved-id` warning (so the drop is never silent).
    const warnings = [...innerWarnings];
    if (hasId && isReserved(id)) {
      warnings.push(warn(
        "reserved-id-subgraph",
        `subgraph id "${id}" is a reserved keyword; an edge referencing it is dropped`,
        h.idLoc,
      ));
    }
    // v1.6 #3 — a PAREN-form subgraph title is Mermaid-REJECTS → fatal (block
    // supported:false; the best-effort subgraph model is still exposed).
    if (header && header.fatalReason) {
      warnings.push(fatalWarn("invalid-subgraph-title", header.fatalReason, header.fatalReason, h.idLoc));
    }
    return { nodes, edges, subgraphs: [sgNode, ...subgraphs], warnings };
  }

// Header variants. Each captures the span of the EDITABLE token so a title/id
// relabel can target it precisely:
//   - `idLoc`    — the id token's span (when an explicit id is present).
//   - `titleSpan`— the title CONTENT span ({ titleStart, titleEnd }), exclusive of
//                  any quotes/brackets, so `source.slice(titleStart,titleEnd) === title`
//                  (the same content-only invariant the node `labelStart/labelEnd`
//                  upholds). Present for every form that has a title.
// A bare PlainId is only an id when it is the WHOLE header (nothing but space /
// comment follows); otherwise the header is a free-text title (`subgraph My Group`).
//
// The id↔title separator is OPTIONAL (`WS?`) for the bracket/quote title forms so
// the no-space canonical Mermaid `subgraph id[title]` / `id("title")` parses to
// { id, title, hasId:true } — NOT a single free-text id. `SubgraphTitle` matches
// only bracket/quote forms (never bare words), so a free-text two-word title like
// `subgraph My Group` still falls through to the FreeTitle catch-all.
SubgraphHeader
  = idl:PlainIdLocated WS? title:SubgraphTitle &EndOfHeader
    { return { id: idl.value, title: title.value, quote: title.quote, idLoc: idl.loc, titleSpan: title.span, fatalReason: title.fatalReason }; }
  / t:SubgraphTitle &EndOfHeader
    // A PAREN title (`subgraph (x)`) is Mermaid-REJECTS even title-only → carry the
    // fatalReason. (A bracket/quoted title-only header is left as-is — not in the v1.6
    // over-lenient target set; the focused unit tests pin those as supported.)
    { return { id: null, title: t.value, quote: t.quote, idLoc: t.loc, titleSpan: t.span, fatalReason: t.fatalReason }; }
  / idl:PlainIdLocated &EndOfHeader
    { return { id: idl.value, title: null, quote: "", idLoc: idl.loc, titleSpan: null }; }
  / t:FreeTitleLocated
    { return { id: null, title: t.value, quote: "", idLoc: t.loc, titleSpan: { titleStart: t.loc.start.column - 1, titleEnd: t.loc.start.column - 1 + t.value.length } }; }

PlainIdLocated  = v:PlainId      { return { value: v, loc: location() }; }
FreeTitleLocated = v:FreeTitle   { return { value: v, loc: location() }; }

// The header ends when only inline space and/or a comment remain before the NL.
EndOfHeader = Sp ("%%" / "\n" / "\r" / !.)

// A subgraph title: `[title]`, `["title"]`, `['title']`, `(title)`, `("title")`,
// `('title')`, or a bare quoted run. Returns the title value, the quote char, a
// content-exclusive span ({ titleStart, titleEnd }), and (for the title-only
// header) `loc` (the whole-token location, used as the editable id span fallback).
// `cLoc:HERE` captures the column of the first CONTENT char so the span excludes
// the surrounding bracket/quote delimiters.
// v1.6 #3 — the PAREN title forms (`(title)`, `("title")`, `('title')`) are
// Mermaid-REJECTS (oracle: `subgraph one(The One)`, `subgraph 2nd ("Second Group")`,
// `subgraph proc (the title)` → Parse error); only the BRACKET (`[title]`, `["title"]`)
// and bare-QUOTED title forms render (with an id). The paren alternatives carry a
// `fatalReason` so the Subgraph action emits a fatal warning (block supported:false);
// the best-effort subgraph model is still exposed.
SubgraphTitle
  = "[" cLoc:HERE '"' c:DQuoted '"' "]" { return { value: c, quote: '"', span: contentSpan(c, cLoc), loc: location() }; }
  / "[" cLoc:HERE "'" c:SQuoted "'" "]" { return { value: c, quote: "'", span: contentSpan(c, cLoc), loc: location() }; }
  / "[" cLoc:HERE c:SquareRun "]"       { return { value: c.trim(), quote: "", span: trimmedSpan(c, cLoc), loc: location() }; }
  / "(" cLoc:HERE '"' c:DQuoted '"' ")" { return { value: c, quote: '"', span: contentSpan(c, cLoc), loc: location(), fatalReason: subgraphParenReason() }; }
  / "(" cLoc:HERE "'" c:SQuoted "'" ")" { return { value: c, quote: "'", span: contentSpan(c, cLoc), loc: location(), fatalReason: subgraphParenReason() }; }
  / "(" cLoc:HERE c:ParenRun ")"        { return { value: c.trim(), quote: "", span: trimmedSpan(c, cLoc), loc: location(), fatalReason: subgraphParenReason() }; }
  / cLoc:HERE '"' c:DQuoted '"'         { return { value: c, quote: '"', span: contentSpan(c, cLoc, 1), loc: location() }; }
  / cLoc:HERE "'" c:SQuoted "'"         { return { value: c, quote: "'", span: contentSpan(c, cLoc, 1), loc: location() }; }

// A bare free-text subgraph title (no id, no brackets, no quotes) — e.g.
// `subgraph My Group`. Stops at end-of-line / comment.
FreeTitle = chars:(!("\n" / "%%") c:. { return c; })+ { return chars.join("").trim(); }

// ─── Edge chains ──────────────────────────────────────────────────────────────
// `A --> B`, `A --> B --> C`, with optional pipe / inline-dash labels and either
// endpoint optionally shaped. Each link emits an edge; a shaped endpoint also
// emits a node. Reversed (`<--`) operators swap from/to so the model matches
// Mermaid's directed semantics.

// An EDGE CHAIN over node GROUPS. A group is one node, or several `&`-joined nodes
// (`A & B`) — Mermaid's fan-out/fan-in shorthand. Each link connects every node in
// the previous group to every node in the next group (the cartesian product), which
// is how Mermaid renders `A & B --> C & D` (A→C, A→D, B→C, B→D). Per the renders-it
// rule the `&` form is therefore SPLIT into the real pairwise edges rather than
// hard-failing the block; a single `fanout-split` advisory is attached for the
// chain. A shaped endpoint still emits its node; an endpoint that is a reserved
// keyword still drops its edge (with a `reserved-id` warning so the drop is never
// silent) and is never emitted as a node.
EdgeChain
  = first:NodeGroup rest:(seg:EdgeSegGroup { return seg; })+
  {
    const out = { nodes: [], edges: [], subgraphs: [], warnings: [] };
    const seenWarn = new Set();
    const pushWarn = (w) => {
      // Honor an optional `_dedup` rider so two DISTINCT reserved ids on one line each
      // warn (the bare code|line key would collapse them to one). The rider is NOT
      // stripped here — it survives up to Body.addWarn, which widens its key the same
      // way and strips it before the warning reaches the public {code,message,line} shape.
      const key = w.code + "@" + w.line + (w._dedup !== undefined ? "@" + w._dedup : "");
      if (!seenWarn.has(key)) { seenWarn.add(key); out.warnings.push(w); }
    };
    const emitNode = (ref) => {
      if (ref.shapeInfo && !isReserved(ref.id)) {
        out.nodes.push(makeNode(ref.id, ref.shapeInfo, ref.loc, ref.shapeLoc));
      }
    };
    // A hyphen-truncated endpoint (`send-email` → `send`) RENDERS as a longer id in
    // Mermaid, so we keep the truncate behavior + advise. Fires for every truncated
    // ref in any group (deduped per code|line).
    const noteTruncation = (ref) => {
      if (ref.truncated) {
        // Two DISTINCT truncated ids on one line (`foo-bar --> baz-qux`) must EACH
        // warn — the bare code|line key would collapse them to one (the baz
        // truncation went silent). Ride the kept id as `_dedup` so the key widens to
        // code@line@keptId; a SAME kept-id repeat (PEG backtracking, or `foo-bar -->
        // foo-qux`) still collapses (same key), matching the reserved-id endpoint path.
        const tw = warn("id-truncated", `hyphenated id truncated to "${ref.id}"; the remainder after the hyphen is discarded`, ref.idLoc);
        tw._dedup = ref.id;
        pushWarn(tw);
      }
    };
    // Whether any group in the chain has more than one node (a real fan-out/fan-in).
    let sawFanout = first.refs.length > 1;
    // v1.6 #3 — a bare `x`/`o` source glued to an arrow (`x==>B`/`o-->B`) is a
    // Mermaid-REJECTS form → fatal (block supported:false). Only the FIRST group's refs
    // (the chain source) can carry this; a later group is preceded by an arrow + space.
    const noteGluedXO = (ref) => {
      if (ref.gluedXO) {
        pushWarn(fatalWarn(
          "invalid-edge",
          `a bare "${ref.id}" glued to an arrow is ambiguous with an arrow head`,
          `a bare "${ref.id}" source glued to an arrow operator — won't render in Mermaid (add a space or rename the node)`,
          ref.idLoc,
        ));
      }
    };
    for (const ref of first.refs) { emitNode(ref); noteTruncation(ref); noteGluedXO(ref); }
    let prevGroup = first;
    for (const seg of rest) {
      if (seg.group.refs.length > 1) sawFanout = true;
      for (const ref of seg.group.refs) { emitNode(ref); noteTruncation(ref); }
      const link = seg.link;
      // v1.6 #3 — an unquoted pipe label with a bracket is a Mermaid-REJECTS form →
      // FATAL warning (block supported:false). The edge is still emitted below (the
      // best-effort model is exposed for editing).
      if (link.pipeFatalReason) {
        pushWarn(fatalWarn("invalid-label", link.pipeFatalReason, link.pipeFatalReason, location()));
      }
      // A non-canonical inline-dash label on this segment → one advisory (per line).
      if (link.inlineDash && link.label !== undefined && link.label !== null) {
        pushWarn(warn("inline-dash-label", "inline-dash edge label is non-canonical; prefer the pipe form `-->|label|`", location()));
      }
      // A non-canonical inline-DOTTED label on this segment → one advisory (per line),
      // parallel to inline-dash. The pipe form `-.->|label|` is the canonical dotted
      // labeled edge; the inline-dot form is rendered but off-canonical.
      if (link.inlineDot && link.label !== undefined && link.label !== null) {
        pushWarn(warn("inline-dot-label", "inline-dot edge label is non-canonical; prefer the pipe form `-.->|label|`", location()));
      }
      // Per-construct `unsupported-arrow` recovery, with the v1.6 RENDERS-vs-REJECTS
      // split. A connector matched as an UnsupportedArrow alt of the Link rule emits NO
      // edge for this segment + one `unsupported-arrow` warning; the surrounding edges
      // survive. The warning's FATALITY follows real Mermaid:
      //   - `unsupportedFatal` (Mermaid REJECTS the whole diagram — `-->o`/`-->x`/`==>o`/
      //     `-.->x`, dangling `==`, `<==`, `o==`/`x==`): the warning is FATAL → the block
      //     is supported:false + "won't render" (best-effort model still exposed).
      //   - `unsupported` (Mermaid RENDERS but we don't model the irregular metadata —
      //     quirky leading-head `o--x`/`o==>`/`o---`, dangling `--` via line-merge): the
      //     warning is a GENTLE advisory, block stays supported:true.
      // This is the structural backstop: no arrow form discards the whole block silently
      // (the maximal silent-loss class) — a reject is an honest supported:false, a render
      // is a skip-warn.
      if (link.unsupportedFatal) {
        pushWarn(fatalWarn(
          "unsupported-arrow",
          "this arrow form is not valid; the edge is skipped",
          "an arrow form Mermaid rejects — won't render in Mermaid",
          location(),
        ));
        prevGroup = seg.group;
        continue;
      }
      if (link.unsupported) {
        pushWarn(warn("unsupported-arrow", "this arrow form is not modeled; the edge is skipped (surrounding edges are kept)", location()));
        prevGroup = seg.group;
        continue;
      }
      // WARN-best-effort advisory for the renders-but-off-canonical arrow forms
      // (renders-but-non-canonical → warn): a LEADING circle/cross head on a forward arrow
      // (`o-->`/`x-->`, decorative per the oracle), a MULTI-shaft x/o head (`---x`,
      // `----o`; the length-1 `--x`/`--o` is in-contract → no warn), or an INVISIBLE
      // link (`~~~`). The clean must-parse forms (`-->`, `<-->`/`<--->`, `o--o`/`x--x`,
      // `--x`/`--o`) do NOT warn. One advisory per segment (deduped per code@line).
      const isMultiShaftXO = (link.head === "circle" || link.head === "cross") && link.stroke === "solid" && link.length >= 2;
      if (link.leadingHead || isMultiShaftXO || link.stroke === "invisible") {
        pushWarn(warn("non-canonical-arrow", "this arrow form renders but is non-canonical; prefer a standard arrow operator", location()));
      }
      // ADDITIVE arrow metadata for every edge this segment emits (head/stroke/
      // bidirectional/length), matching real Mermaid's getEdges() type/stroke/length.
      const edgeMeta = { head: link.head, stroke: link.stroke, bidirectional: link.bidirectional, length: link.length };
      // Cartesian product of (prev group) × (this group) — one edge per pair, in
      // source order (every prev node against the first next node, then the second…).
      for (const pRef of prevGroup.refs) {
        for (const nRef of seg.group.refs) {
          if (isReserved(pRef.id) || isReserved(nRef.id)) {
            // A reserved endpoint is a Mermaid-REJECTS form — Mermaid parse-errors the
            // whole diagram. Per the contract we keep a best-effort model (this edge is
            // dropped, surroundings stay) but emit a FATAL warning so the envelope
            // reports the block supported:false. (Case-sensitive: only the exact
            // lowercase reserved tokens hit this; `End`/`STYLE` are normal ids.)
            const resId = isReserved(pRef.id) ? pRef.id : nRef.id;
            const rw = fatalWarn(
              "reserved-id",
              `edge endpoint "${resId}" is a reserved keyword; this edge is dropped`,
              `reserved Mermaid keyword "${resId}" used as an edge endpoint — won't render in Mermaid`,
              { start: pRef.loc.start, end: nRef.loc.end },
            );
            rw._dedup = resId; // case-sensitive exact reserved token
            pushWarn(rw);
            continue;
          }
          const [from, to] = link.reversed ? [nRef.id, pRef.id] : [pRef.id, nRef.id];
          // edge span: from this prev node's start to this next node's end.
          const loc = { start: pRef.loc.start, end: nRef.loc.end };
          out.edges.push(makeEdge(from, to, link.label, loc, edgeMeta));
        }
      }
      prevGroup = seg.group;
    }
    if (sawFanout) {
      pushWarn(warn("fanout-split", "`&` fan-out/fan-in edge split into the individual pairwise edges", location()));
    }
    return out;
  }

// A node group: one node, or several `&`-joined nodes (`A & B & C`). The `&` form
// is Mermaid's fan-out/fan-in shorthand; EdgeChain expands it into pairwise edges.
NodeGroup
  = first:NodeRef rest:(Sp "&" Sp n:NodeRef { return n; })*
  { return { refs: [first, ...rest] }; }

// A segment = arrow, optional pipe label, then the next node GROUP. A pipe label
// (`-->|yes|`) takes precedence over an inline-dash label if both somehow appear.
EdgeSegGroup
  = Sp link:Link Sp pipe:PipeLabel? Sp group:NodeGroup
  {
    const hasPipe = pipe !== null && pipe !== undefined;
    const label = hasPipe ? pipe.value : link.label;
    // v1.6 #3 — an unquoted pipe label with a bracket is Mermaid-rejected; carry its
    // fatal reason so EdgeChain emits a fatal warning (block supported:false).
    const pipeFatalReason = hasPipe ? pipe.fatalReason : undefined;
    // The inline-dash label form (`-- text -->`) is non-canonical (prefer the pipe
    // form `-->|text|`); flag it for an advisory. A pipe label takes precedence and
    // is canonical, so it never carries the inline-dash flag.
    const inlineDash = !hasPipe && link.inlineDash === true;
    // The inline-DOTTED label form (`-. text .-> `) gets its own advisory code
    // (`inline-dot-label`), parallel to inline-dash. A pipe label takes precedence
    // and is canonical, so it clears the dot flag too.
    const inlineDot = !hasPipe && link.inlineDot === true;
    return {
      link: {
        label,
        reversed: link.reversed,
        inlineDash,
        inlineDot,
        // ADDITIVE arrow metadata threaded from the Link rule (head/stroke/
        // bidirectional/length), plus the `unsupported` flag for a
        // recognized-but-not-modeled / Mermaid-rejected arrow (fix C: skip-warn).
        head: link.head,
        stroke: link.stroke,
        bidirectional: link.bidirectional,
        length: link.length,
        unsupported: link.unsupported === true,
        unsupportedFatal: link.unsupportedFatal === true,
        leadingHead: link.leadingHead === true,
        pipeFatalReason,
      },
      group,
    };
  }

// A pipe edge label `-->|text|`. Returns { value, fatalReason }. v1.6 #3: an UNQUOTED
// pipe label containing a BRACKET char `()[]{}` is a Mermaid-REJECTS form (oracle:
// `A -->|check(x)| B` → Parse error; quoted `|"check(x)"|` and other punctuation
// render), so it carries a fatalReason → the block is reported supported:false (the
// edge + its label are still exposed for editing). Same bracket rule the shape labels
// use (only brackets trip it; `<`,`&`,`:`,`/`,`-`,`.` render).
PipeLabel
  = "|" '"' c:DQuoted '"' "|" { return { value: c }; }
  / "|" "'" c:SQuoted "'" "|" { return { value: c }; }
  / "|" c:PipeRun "|"
    {
      const v = c.trim();
      const fatalReason = /[()\[\]{}]/.test(v)
        ? `unquoted bracket character inside a pipe edge label — won't render in Mermaid (quote the label)`
        : undefined;
      return { value: v, fatalReason };
    }

PipeRun = chars:(!("|" / "\n") c:. { return c; })* { return chars.join(""); }

// ─── A single bare node / shaped node on its own line ─────────────────────────

NodeStmt
  = ref:NodeRef &{ return !isReserved(ref.id); }
  {
    const warnings = [];
    if (ref.truncated) {
      // Two truncated bare nodes in one `;` chain (`foo-bar; baz-qux`) are distinct
      // same-line truncations — ride the kept id as `_dedup` so each surfaces (the
      // bare code|line key collapsed them to one). Same-id repeats still collapse.
      const tw = warn("id-truncated", `hyphenated id truncated to "${ref.id}"; the remainder after the hyphen is discarded`, ref.idLoc);
      tw._dedup = ref.id;
      warnings.push(tw);
    }
    return { nodes: [makeNode(ref.id, ref.shapeInfo, ref.loc, ref.shapeLoc)], edges: [], subgraphs: [], warnings };
  }

// ─── Node reference (id, optionally with a shape) ─────────────────────────────

NodeRef
  = loc:HERE idr:NodeIdRef shapeLoc:HERE shape:NodeShape
    { return { id: idr.id, truncated: idr.truncated, idLoc: idr.loc, shapeInfo: shape, shapeLoc, loc: { start: loc.start, end: location().end } }; }
  / loc:HERE idr:NodeIdRef glued:(&("==" / "--" / "-.") { return true; })?
    {
      // v1.6 #3 — a bare single-char `x`/`o` source GLUED (no space) to an arrow operator
      // is a Mermaid-REJECTS form: `x==>B`, `o-->B`, `x-.->B` → Parse error (the lexer
      // reads the leading `x`/`o` as part of the arrow). A SPACE (`x ==> B`) renders, and
      // any longer/other id (`xy==>B`, `y==>B`) renders — only a lone `x`/`o` abutting
      // `==`/`--`/`-.` trips it. The zero-width `&(...)` lookahead detects the abutting
      // arrow shaft without consuming it (EdgeChain still parses the link normally); the
      // ref carries `gluedXO` so EdgeChain emits a fatal (block supported:false).
      const gluedXO = glued === true && (idr.id === "x" || idr.id === "o") && !idr.truncated;
      return { id: idr.id, truncated: idr.truncated, idLoc: idr.loc, shapeInfo: null, gluedXO, loc: { start: loc.start, end: location().end } };
    }

// A node id plus whether a hyphen tail was consumed-and-DISCARDED (`send-email` →
// id `send`, truncated:true). The discarded off-contract tail RENDERS in Mermaid as
// part of a longer id, so per the renders-it rule we keep parsing (the documented
// truncate behavior) and attach an `id-truncated` advisory rather than failing.
NodeIdRef
  = id:NodeId { return { id, truncated: text() !== id, loc: location() }; }

// HERE captures a zero-width location at the current input position, so callers
// can build a precise start..end span around a following construct.
HERE = "" { return location(); }

// ─── Identifiers ──────────────────────────────────────────────────────────────
// Supported ids are snake_case: [A-Za-z0-9_]. A hyphenated compound (`receive-order`)
// is off-contract — we take the prefix `receive` and discard `-order`, but
// ONLY when the hyphen is followed by an id char (so a `-`/`-.` that begins an
// arrow operator is left for the Link rule).

NodeId "node id"
  = first:[A-Za-z0-9_] rest:IdChar* HyphenTail*
  { return first + rest.join(""); }

IdChar = [A-Za-z0-9_]

// A hyphen that begins a compound id (followed by id chars), NOT an arrow.
HyphenTail = "-" !("-" / ".") IdChar+

// A plain id for subgraph headers (allows internal hyphens since it is not in
// arrow context). The leading-char class is [A-Za-z0-9_] — same as NodeId's —
// so a DIGIT-FIRST subgraph id (`subgraph 1stage[Stage 1]`) parses to
// { id, title, hasId:true } symmetrically with a digit-first NODE id (`1stage[X]`,
// which NodeId already accepts). Without this, PlainId's old [A-Za-z_] leading
// class declined `1stage`, the whole header fell through to the FreeTitle
// catch-all, and a real `id[title]` header was mis-read as one free-text title
// (hasId:false, id = the raw `1stage[Stage 1]` text). the supported id charset permits digit-first ids.
PlainId "plain id"
  = first:[A-Za-z0-9_] rest:[A-Za-z0-9_\-]*
  { return first + rest.join(""); }

// ─── Node shapes ──────────────────────────────────────────────────────────────
// Multi-char opening tokens are tried before single-char ones. Each returns the
// shape token pair, the label content, the quote char, and the content span.

// Each shape's UNQUOTED label run stops ONLY at that shape's OWN closing token, so
// a FOREIGN close-bracket inside the label is kept as content (`A[Order (Pending)]`
// → label `Order (Pending)`; `A(read [x])` → label `read [x]`). This is the v1.4
// renders-it rule: Mermaid renders such a label, so we parse it instead of
// hard-failing. The label run per shape is therefore distinct (a square `[…]` stops
// at `]`, a paren `(…)` at `)`, …). Multi-char shapes stop at their two-char close.
// The quoted forms (shared `QuotedLabel`) are tried first and are unaffected.
NodeShape
  = "[[" l:DoubleSquareLabel "]]" { return shape("[[", "]]", l); }
  / "[(" l:CylinderLabel ")]"     { return shape("[(", ")]", l); }
  / "([" l:StadiumLabel "])"      { return shape("([", "])", l); }
  / "((" l:DoubleCircleLabel "))" { return shape("((", "))", l); }
  / "{{" l:HexagonLabel "}}"      { return shape("{{", "}}", l); }
  / "["  l:SquareLabel "]"        { return shape("[", "]", l); }
  / "("  l:RoundLabel ")"         { return shape("(", ")", l); }
  / "{"  l:BraceLabel "}"         { return shape("{", "}", l); }
  / ">"  l:AsymLabel  "]"         { return shape(">", "]", l); }

// A label = the shared quoted forms, or a raw run that stops at this shape's close.
// QuotedLabel returns { value, quote, labelStart, labelEnd } — the content span is
// captured around the inner content so labelStart/labelEnd are real columns. The
// raw run carries the `!OpenBracket` start-guard (see below).
//
// The unquoted run must NOT begin with an opening bracket char (`[`/`(`/`{`).
// That guard closes the ASYMMETRIC over-bracket class (`A[[[hello]]`, `A((x)`,
// `A{{{x}}`, …): when a multi-char opener like `[[` fails to find its symmetric
// close, the single-char opener `[` would otherwise backtrack and swallow the
// leftover `[` as label content (`label:'[hello'`) — a silent corruption that
// the contract forbids (off-contract input must be warned, never silently
// corrupted). The start-guard is INDEPENDENT of the run's stop token, so relaxing
// the stop token (to keep a FOREIGN close-bracket as content, B4) does not weaken
// the guard: the over-bracket forms still fail to match and the block is reported
// `supported:false` + `parseError` (a clean WARN). A label that genuinely STARTS
// with a bracket must be quoted (`A["[x"]`), which QuotedLabel accepts.
QuotedLabel
  = lLoc:HERE '"' c:DQuoted '"' { return labelSpan(c, '"', lLoc, location()); }
  / lLoc:HERE "'" c:SQuoted "'" { return labelSpan(c, "'", lLoc, location()); }

// Per-shape unquoted labels: quoted-first, then a raw run that stops only at this
// shape's own closing token (so a foreign close-bracket of a DIFFERENT family is
// label content). `!OpenBracket` keeps the asymmetric over-bracket guard.
SquareLabel       = QuotedLabel / lLoc:HERE !OpenBracket c:SquareRun       { return labelSpanRaw(c, "", lLoc); }
RoundLabel        = QuotedLabel / lLoc:HERE !OpenBracket c:RoundRun        { return labelSpanRaw(c, "", lLoc); }
BraceLabel        = QuotedLabel / lLoc:HERE !OpenBracket c:BraceRun        { return labelSpanRaw(c, "", lLoc); }
DoubleSquareLabel = QuotedLabel / lLoc:HERE !OpenBracket c:DoubleSquareRun { return labelSpanRaw(c, "", lLoc); }
CylinderLabel     = QuotedLabel / lLoc:HERE !OpenBracket c:CylinderRun     { return labelSpanRaw(c, "", lLoc); }
StadiumLabel      = QuotedLabel / lLoc:HERE !OpenBracket c:StadiumRun      { return labelSpanRaw(c, "", lLoc); }
DoubleCircleLabel = QuotedLabel / lLoc:HERE !OpenBracket c:DoubleCircleRun { return labelSpanRaw(c, "", lLoc); }
HexagonLabel      = QuotedLabel / lLoc:HERE !OpenBracket c:HexagonRun      { return labelSpanRaw(c, "", lLoc); }

// An opening bracket char — used as a negative lookahead so an unquoted shape
// label can never begin with one (the asymmetric over-bracket corruption guard).
OpenBracket = "[" / "(" / "{"

// The `>]` (asymmetric) shape, like every other shape, must strip surrounding
// quotes so a quoted label reports quote='"'/"'" and a content-EXCLUSIVE span —
// otherwise a relabel honoring labelStart/labelEnd would silently drop the quotes
// (`A>"x"]` → `A>new]`). Mirror the per-shape labels: try the quoted forms first,
// then the raw unquoted run.
// The unquoted run gets the SAME `!OpenBracket` guard the per-shape labels have, for the
// SAME reason: an unquoted asym label must not begin with `[`/`(`/`{`. Without it,
// `A>(text)]` / `A>{x}]` silently parse as a `>]` node whose label keeps the stray
// opener (`label:'(text)'`) — the asymmetric over-bracket corruption class the
// contract forbids. With the guard those forms fail to match the shape, so the
// block is reported `supported:false` + `parseError` (a clean WARN). A label that
// genuinely starts with a bracket must be quoted (`A>"(text)"]`), which the quoted
// alternatives above accept.
AsymLabel
  = lLoc:HERE '"' c:DQuoted '"' { return labelSpan(c, '"', lLoc, location()); }
  / lLoc:HERE "'" c:SQuoted "'" { return labelSpan(c, "'", lLoc, location()); }
  / lLoc:HERE !OpenBracket c:AsymRun { return labelSpanRaw(c, "", lLoc); }

// Raw label runs — opaque text up to this shape's OWN unquoted close token / NL.
// A `%%` inside a label is content, not a comment, so it is NOT excluded here. Each
// run stops only at its shape's close, so a foreign close-bracket of a DIFFERENT
// family (`(` `)` `{` `}` inside a `[…]`, etc.) is kept as label content — the v1.4
// renders-it behavior. Multi-char shapes stop at their full two-char close, so a
// SINGLE foreign close char of the same family (`]` inside `[[…]]`) is also kept.
SquareRun       = chars:(!("]" / "\n") c:. { return c; })* { return chars.join(""); }
RoundRun        = chars:(!(")" / "\n") c:. { return c; })* { return chars.join(""); }
BraceRun        = chars:(!("}" / "\n") c:. { return c; })* { return chars.join(""); }
DoubleSquareRun = chars:(!("]]" / "\n") c:. { return c; })* { return chars.join(""); }
CylinderRun     = chars:(!(")]" / "\n") c:. { return c; })* { return chars.join(""); }
StadiumRun      = chars:(!("])" / "\n") c:. { return c; })* { return chars.join(""); }
DoubleCircleRun = chars:(!("))" / "\n") c:. { return c; })* { return chars.join(""); }
HexagonRun      = chars:(!("}}" / "\n") c:. { return c; })* { return chars.join(""); }
AsymRun         = chars:(!("]" / "\n") c:. { return c; })* { return chars.join(""); }
// An unquoted subgraph-title run inside `(...)` — opaque up to the close paren.
ParenRun        = chars:(!(")" / "\n") c:. { return c; })* { return chars.join(""); }

DQuoted = chars:(!('"' / "\n") c:. { return c; })* { return chars.join(""); }
SQuoted = chars:(!("'" / "\n") c:. { return c; })* { return chars.join(""); }

// ─── Links (arrow operators) ──────────────────────────────────────────────────
// Returns { label, reversed }. The inline-dash label form (`-- text -->`) is
// matched as one Link before the bare `--`.

Link "arrow"
  // Inline dash label first (so `-- text -->` is one token, not `--` + ...). The
  // surrounding whitespace is optional so the compact (`A--text-->B`) and
  // one-side-glued (`A -- text-->B`, `A--text --> B`) forms parse to ONE labelled
  // edge instead of fabricating a phantom node from the label text. The CLOSING
  // arrow is matched as a full-length shaft run (`DashArrowClose`/`ThickArrowClose`,
  // ANY shaft length `-- -* >` / `== =* >` — same length-variant family the bare
  // arrow at the `"--" "-"* ">"` rule accepts) so `A -- text ---> B` consumes the
  // whole `--->` and the shaft chars never leak into the label.
  // NOTE on `length` for the inline-LABEL arms: the matched text includes the label
  // (which may itself contain `-`/`=`/`.`), so a text()-based shaft count would be
  // wrong. A labeled edge's shaft length is not meaningful for editing, so these arms
  // report the canonical `length: 1`; only the BARE arrow arms below derive length
  // from the shaft via linkLen (where text() IS the shaft).
  = "--" WS? l:InlineDashLabel WS? DashArrowClose { return link(l, false, "arrow", "solid", false, 1, { inlineDash: true }); }
  / "==" WS? l:InlineThickLabel WS? ThickArrowClose { return link(l, false, "arrow", "thick", false, 1, { inlineDash: true }); }
  // Labeled OPEN-link (NO arrowhead): `A -- label --- B`, `A -- label -- B`,
  // `A -- label ---- B` (and the thick `A == label === B` variants). Mirrors the
  // labeled-arrow branches above, but the CLOSE is a head-less dash/equals run
  // (`InlineDashOpenClose`/`InlineThickOpenClose` = `--- -* !">"` / `=== =* !">"`).
  // Without these branches the labeled-open-link FALSE-GREENED: the labeled-arrow
  // branch needs a trailing `>`, so it declined; Peggy backtracked to the bare `--`
  // open link and re-read the single-token label as a NodeRef — fabricating a phantom
  // node + two edges (`A→label`, `label→B`) with NO warning. Emitting ONE labeled
  // open-link edge here keeps the model correct.
  //
  // v1.6 #1b — the open close requires ≥3 dash/equals chars (`---`/`===`), NOT 2.
  // REAL Mermaid REJECTS a 2-char head-less close on a labeled edge (`A -- lbl -- B`,
  // `A == lbl == B` → Parse/Lexical error), while a 3+-char close renders (`A -- lbl
  // --- B` → A→B label lbl). And an embedded GLUED 3+-dash run inside the label is a
  // LINK to Mermaid, not label text (`A -- a---b ---- B` → A -[label a]-> b, b → B —
  // a chained edge with a middle node, NOT one edge labeled `a---b`). The
  // InlineDashLabel run therefore stops at ANY glued/spaced dash run of length ≥2
  // (`InlineDashLink` lookahead) so: a 3+-dash run becomes the close (label `a`, node
  // `b`); a 2-dash run fails the close (needs ≥3) → the whole inline arm declines →
  // the block is supported:false, matching Mermaid's reject of `a--b`.
  / "--" WS? l:InlineDashLabel Sp InlineDashOpenClose { return link(l, false, "open", "solid", false, 1, { inlineDash: true }); }
  / "==" WS? l:InlineThickLabel Sp InlineThickOpenClose { return link(l, false, "open", "thick", false, 1, { inlineDash: true }); }
  // Inline DOTTED label: `A -. text .-> B` (dotted arrow close) and `A -. text .- B`
  // (dotted head-less close). Real Mermaid renders these as ONE labeled dotted edge,
  // so per the renders-it rule we emit ONE labeled edge (carrying the label + an
  // `inline-dot-label` advisory) instead of hard-failing the whole block — the exact
  // parallel of the InlineDashLabel / InlineThickLabel arms above, for the dotted
  // shaft. The OPEN token is `-.` (the same dotted opener the bare dotted arrows
  // `-." "."* "->"` / `-." "."* "-"` use); the CLOSE is a dotted-shaft run that begins
  // with `.` (`DotArrowClose` = `. .* ->`, any extra-dot length; `DotOpenClose` =
  // `. .* - !">"`, head-less). The arrow close ends in `>` so it is unambiguous even
  // glued (`Sp DotArrowClose`); the head-less close MUST be whitespace-delimited
  // (`WS DotOpenClose`) so a `.-`/`-.` glued INSIDE the label is preserved, not read
  // as a close — mirroring the dash open-link reasoning. Tried before the bare dotted
  // arrows below so a labeled dotted edge is claimed here, and before the dotted
  // entries in the MIXED-SHAFT branches never apply (those openers are `--`/`==`, not
  // `-.`), so a dotted open + dotted close is correctly a MATCHED-shaft edge, not mixed.
  / "-." WS? l:InlineDotLabel WS? DotArrowClose { return link(l, false, "arrow", "dotted", false, 1, { inlineDot: true }); }
  / "-." WS? l:InlineDotLabel WS DotOpenClose { return link(l, false, "open", "dotted", false, 1, { inlineDot: true }); }
  // MIXED-SHAFT labeled inline edge → honest hard-fail. Real Mermaid REJECTS an edge
  // whose OPEN shaft and CLOSE shaft differ in style (a dash open `--` with a thick or
  // dotted close `===`/`.->`, or vice-versa). These branches are reached ONLY when every
  // MATCHED-shaft labeled branch above has declined (a same-style close would have been
  // claimed there), so the open style here never equals the close style. Detecting it
  // explicitly turns what used to SILENTLY mis-parse into two phantom edges (`A -- label
  // === B` → `A→label`, `label→B`, NO warning — a silent mis-parse v1.4 prohibits) into a
  // clean `parseError` (supported:false). `error()` aborts the parse; the envelope catches
  // the SyntaxError and reports the block unsupported. The label run (`MixedShaftLabel`)
  // stops at the first WS-delimited FOREIGN close so the foreign close is matched (and
  // rejected) rather than swallowed.
  / "--" WS MixedShaftLabel WS (ThickArrowClose / ThickOpenClose / DotClose)
    { error("edge shaft styles must match: a dash `--` open with a non-dash close is not a valid edge"); }
  / "==" WS MixedShaftLabel WS (DashArrowClose / DashOpenClose / DotClose)
    { error("edge shaft styles must match: a thick `==` open with a non-thick close is not a valid edge"); }
  // ─────────────────────────────────────────────────────────────────────────
  // FAMILY-COMPLETE bare (unlabeled) arrow operators. Every form below is VARIADIC
  // in shaft length (parallel to the long-standing forward `"--" "-"* ">"`), so a
  // length-variant parses as the same edge differing only in `length` (oracle:
  // `--->`=`-->`, `<--->`=`<-->`, `---x`=`--x`). Metadata (head/stroke/bidirectional/
  // length) mirrors real Mermaid v11's getEdges() type/stroke/length (oracle-pinned).
  //
  // ORDERING is load-bearing (PEG is ordered choice, first match wins):
  //   1. Mermaid-REJECTED trailing-head forms (`-->o`/`-->x`) — caught FIRST as
  //      `unsupported` skip-warn so they don't half-match `-->` and orphan the `o`/`x`.
  //   2. BIDIRECTIONAL before reverse/forward (a head on BOTH ends; `<-->` is a
  //      superstring of `<--`, `o--o` of `o--`, so the two-headed form must win).
  //   3. LEADING-head forms (`o-->`,`x-->`) before the bare dash arrows.
  //   4. trailing-head x/o (variadic) before the head-less open link.
  // ─────────────────────────────────────────────────────────────────────────

  // (1) Mermaid REJECTS a circle/cross AFTER a `>` arrow head when the `o`/`x` is a
  // STANDALONE token (`C -->o D` → Parse error). It is NOT rejected when the `o`/`x`
  // is the START of the target node id — `a-->x2`, `a-->o2`, even bare `a-->x`, all
  // render as `a → <node>` (oracle14). So this rejected-arm must fire ONLY for the
  // standalone-token case, distinguished by:
  //   - `!IdChar` after the `o`/`x` → it is a WHOLE token, not the prefix of `x2`/`o2`;
  //   - `&WS` → it is followed by whitespace + another node (the `C -->o D` shape),
  //     NOT end-of-line (bare `a-->x`, where `x` IS the target node).
  // When the arm declines (`a-->x2`, `a-->x`), the line falls through to the plain
  // `-->` arrow + a normal NodeRef target. v1.6 #3: a standalone trailing-head-after-
  // arrow (`-->o`/`-->x`/`==>o`/`-.->x`) is a Mermaid-REJECTS form (oracle-confirmed
  // Parse error — REJECTS the WHOLE diagram). So we MATCH it and mark it
  // `unsupportedFatal`: EdgeChain drops this edge + emits a FATAL `unsupported-arrow`
  // warning, so the block is reported supported:false + "won't render" (the best-effort
  // model — the surrounding edges — is still exposed for editing). This is the
  // RENDERS-vs-REJECTS split of the old skip-warn backstop: a Mermaid-rejected arrow
  // is supported:false (not the gentler supported:true skip the renders forms get).
  / "--" "-"* ">" ("o" / "x") !IdChar &WS   { return link(undefined, false, "arrow", "solid",   false, 1, { unsupportedFatal: true }); }
  / "==" "="* ">" ("o" / "x") !IdChar &WS   { return link(undefined, false, "arrow", "thick",   false, 1, { unsupportedFatal: true }); }
  / "-." "."* "->" ("o" / "x") !IdChar &WS  { return link(undefined, false, "arrow", "dotted",  false, 1, { unsupportedFatal: true }); }

  // (2) BIDIRECTIONAL — a head on both ends → Mermaid's double_arrow_* family.
  //   solid arrow:  `<-->`, `<--->`, `<---->` (variadic) → double_arrow_point.
  / "<--" "-"* ">"              { return link(undefined, false, "arrow",  "solid",  true, linkLen(text(), "solid", true), {}); }
  //   thick arrow:  `<==>`, `<===>` → double_arrow_point / thick.
  / "<==" "="* ">"             { return link(undefined, false, "arrow",  "thick",  true, linkLen(text(), "thick", true), {}); }
  //   dotted arrow: `<-.->`, `<-..->` → double_arrow_point / dotted.
  / "<-." "."* "->"           { return link(undefined, false, "arrow",  "dotted", true, linkLen(text(), "dotted", true), {}); }
  //   circle/cross bidir: `o--o`,`o---o`,`x--x` (+ thick/dotted) → double_arrow_circle/cross.
  / "o--" "-"* "o"            { return link(undefined, false, "circle", "solid",  true, linkLen(text(), "solid", true), {}); }
  / "x--" "-"* "x"            { return link(undefined, false, "cross",  "solid",  true, linkLen(text(), "solid", true), {}); }
  / "o==" "="* "o"            { return link(undefined, false, "circle", "thick",  true, linkLen(text(), "thick", true), {}); }
  / "x==" "="* "x"            { return link(undefined, false, "cross",  "thick",  true, linkLen(text(), "thick", true), {}); }
  / "o-." "."* "-o"          { return link(undefined, false, "circle", "dotted", true, linkLen(text(), "dotted", true), {}); }
  / "x-." "."* "-x"          { return link(undefined, false, "cross",  "dotted", true, linkLen(text(), "dotted", true), {}); }

  // (3) LEADING circle/cross head on a forward arrow. Oracle: a LEADING o/x is
  // DECORATIVE when a `>` head is present — `o-->`/`x-->` render as `arrow_point`
  // (the trailing `>` wins), NOT circle/cross. So head:'arrow' here, matching
  // Mermaid. Tried before the bare dash/thick/dotted arrows. (Mermaid also renders
  // `o--x` as arrow_cross / `x--o` as arrow_circle — the TRAILING head wins; those
  // fall through to the trailing-x/o arms below since the leading o/x is skipped by
  // these `(">")`-only alts. A leading-head + head-less close like `o---` is not a
  // distinct Mermaid form, so it is left to fall through / be unsupported.)
  // Only the SOLID leading-arrow is modeled (oracle: `o-->`/`x-->` = arrow_point /
  // stroke:NORMAL / variadic length — clean). The leading-head over a THICK or DOTTED
  // shaft is a Mermaid quirk (`o==>` renders arrow_point / stroke:NORMAL, not thick;
  // `o-.->` renders arrow_point / dotted len1) — irregular metadata, so those are NOT
  // modeled here; they fall to the fix-C catch-all (unsupported-arrow skip-warn).
  / "o--" "-"* ">"           { return link(undefined, false, "arrow",  "solid",  false, leadingLen(text()), { leadingHead: true }); }
  / "x--" "-"* ">"           { return link(undefined, false, "arrow",  "solid",  false, leadingLen(text()), { leadingHead: true }); }

  // reverse-only (a left head, no right head): `<--`, `<---`, `<----` (variadic).
  // Oracle: arrow_open, reversed (caller swaps from/to). Tried AFTER the bidir `<-->`
  // arm so the trailing `>` is always claimed as the second head first.
  // `<---`+ (≥3 dashes reverse) RENDERS in Mermaid (reversed open edge). Bare `<--`
  // (exactly 2 dashes) is a Mermaid-REJECTS form standalone (`A <-- B` → Parse error)
  // but RENDERS embedded via the same line-merge quirk as bare `--`, so — exactly like
  // bare `--` — it is the GENTLE non-fatal `unsupported` skip (drop this edge, keep
  // surroundings, block supported:true) rather than a FATAL: a fatal here would
  // regress the embedded multi-edge case (silently losing the surrounding edges, a the contract
  // violation). A standalone bare `<--` thus yields an empty/best-effort block.
  / "<--" "-"+                { return link(undefined, true,  "open",   "solid",  false, linkLen(text(), "solid", true), {}); }
  / "<--"                     { return link(undefined, false, "open",   "solid",  false, 1, { unsupported: true }); }
  // `<===`+ (≥3 equals reverse) RENDERS; bare `<==` (exactly 2) → FATAL (v1.6 #3).
  / "<==" "="+                { return link(undefined, true,  "open",   "thick",  false, linkLen(text(), "thick", true), {}); }
  / "<=="                     { return link(undefined, false, "open",   "thick",  false, 1, { unsupportedFatal: true }); }
  / "<-." "."* "-"            { return link(undefined, true,  "open",   "dotted", false, linkLen(text(), "dotted", true), {}); }

  // INVISIBLE link `~~~` / `~~~~` (≥3 tildes; `~~` is a Mermaid lexical error).
  // Oracle: arrow_open / stroke:invisible / variadic length.
  / "~~" "~"+                 { return link(undefined, false, "open",   "invisible", false, linkLen(text(), "invisible", false), {}); }

  // Thick, with shaft length variants (`==>`, `===>`, `====>`). Routed through
  // ThickArrowClose ("==" "="* ">", any shaft length ending in `>`) so the bare
  // thick arrow accepts every length the labeled-thick form already does — mirror
  // of the bare-dash `"--" "-"* ">"` path below. (Tried before the headless
  // `===`/`====` open link so a trailing `>` is always claimed as the arrow head.)
  / ThickArrowClose            { return link(undefined, false, "arrow",  "thick",  false, linkLen(text(), "thick", true), {}); } // `==>`, `===>`, `====>`
  / "==" "="* "x"             { return link(undefined, false, "cross",  "thick",  false, linkLen(text(), "thick", true), {}); } // `==x`, `===x`
  / "==" "="* "o"             { return link(undefined, false, "circle", "thick",  false, linkLen(text(), "thick", true), {}); } // `==o`, `===o`
  / "===" "="*                 { return link(undefined, false, "open",   "thick",  false, linkLen(text(), "thick", false), {}); } // `===`, `====`, … (open link, no head)
  // Dotted (length variants `-.->`, `-..->`); + trailing x/o + head-less open.
  / "-." "."* "->"             { return link(undefined, false, "arrow",  "dotted", false, linkLen(text(), "dotted", true), {}); }
  / "-." "."* "-x"            { return link(undefined, false, "cross",  "dotted", false, linkLen(text(), "dotted", true), {}); } // `-.-x`, `-..-x`
  / "-." "."* "-o"            { return link(undefined, false, "circle", "dotted", false, linkLen(text(), "dotted", true), {}); } // `-.-o`, `-..-o`
  / "-." "."* "-"             { return link(undefined, false, "open",   "dotted", false, linkLen(text(), "dotted", true), {}); }
  // Solid arrow / open link, with length variants (`-->`, `--->`, `---`, `----`).
  / "--" "-"* ">"              { return link(undefined, false, "arrow",  "solid",  false, linkLen(text(), "solid", true), {}); }
  / "--" "-"* "x"             { return link(undefined, false, "cross",  "solid",  false, linkLen(text(), "solid", true), {}); } // `--x`, `---x`, `----x`
  / "--" "-"* "o"             { return link(undefined, false, "circle", "solid",  false, linkLen(text(), "solid", true), {}); } // `--o`, `---o`, `----o`
  / "--" "-"+                  { return link(undefined, false, "open",   "solid",  false, linkLen(text(), "solid", false), {}); } // `---`, `----`
  // v1.6 #1b — a bare `--` / `==` (length-1 head-less link) is NOT a valid standalone
  // edge in REAL Mermaid (`A -- B` / `A == B` → Parse error; the minimum head-less
  // open link is `---` / `===`, handled above). It is matched here LAST and marked
  // `unsupported` so EdgeChain drops THIS edge block-locally (an `unsupported-arrow`
  // advisory) instead of either (a) FALSE-GREENing `A -- lbl -- B` into two phantom
  // edges [if it were a normal open link] or (b) failing the WHOLE block and silently
  // losing the surrounding on-contract edges [if it had no arm at all] — the latter is
  // the the contract "never silently drop a surrounding edge" violation a multi-line block hits
  // (`P0-->A / A -- B / B-->P1`, which Mermaid renders via line-merge). Tried after the
  // labeled-inline arms (top of Link) so a real labeled edge is claimed first; only a
  // dangling bare `--`/`==` with no label/close reaches here.
  // Dangling `==` (length-1 thick open) is a Mermaid-REJECTS form even embedded
  // (`A == B` → Parse error, no line-merge rescue) → FATAL (supported:false).
  / "==" !("=" / ">" / "x" / "o")  { return link(undefined, false, "open",   "thick",  false, 1, { unsupportedFatal: true }); }
  // Dangling `--` (length-1 dash open) is the ONE exception: REAL Mermaid RENDERS it
  // embedded via a line-merge quirk (`P0-->A / A -- B / B-->P1` → P0->A, A->P1), so a
  // FATAL here would silently lose the surrounding on-contract edges (the contract violation).
  // Mark it the GENTLER non-fatal `unsupported` (skip this edge, keep surroundings,
  // block stays supported:true). Standalone `A -- B` then yields an empty supported
  // block, which the differential coverage treats identically to a reject (∅ == ∅).
  / "--" !("-" / ">" / "x" / "o")  { return link(undefined, false, "open",   "solid",  false, 1, { unsupported: true }); }

  // v1.6 #3 — a bare LEADING-head thick `o==` / `x==` (exactly 2 equals, NO trailing
  // head/extra equals) is a Mermaid-REJECTS form (oracle: `A o== B` / `A x== B` →
  // Parse error, even embedded) → FATAL. The longer / trailing-head variants
  // (`o===`, `x==o`, `o==>`) RENDER and fall to the non-fatal skip catch-all below.
  / ("o" / "x") "==" !("=" / ">" / "x" / "o")
    { return link(undefined, false, "open", "thick", false, 1, { unsupportedFatal: true }); }

  // FIX C catch-all — a LEADING circle/cross head (`o`/`x`) on a shaft whose
  // TRAILING combination is NOT one of the cleanly-modeled forms above (e.g.
  // `o--x`, `x--o`, `o==>`, `o---`). Oracle: these RENDER in Mermaid, but with
  // IRREGULAR metadata (a leading `o`/`x` over a `==` shaft collapses the stroke to
  // `normal`; a leading head over a head-less shaft renders `arrow_open`) — too
  // quirky to model faithfully and outside the stated fix scope. Rather than let
  // them HARD-FAIL the whole block (the data-loss class this fix exists to kill), we
  // MATCH the arrow shape and mark it `unsupported` → EdgeChain drops THIS edge with
  // an `unsupported-arrow` advisory, surrounding edges survive. This is the
  // structural backstop generalized: any leading-head arrow shape we don't model
  // skips block-locally, never nuking the block. The shaft run is greedy over the
  // stroke chars + an optional trailing head, bounded so it stops at the first
  // non-shaft/non-head char (it can't swallow the next node).
  / ("o" / "x") ("-" / "=" / ".")+ ("-" / "=" / "." / ">" / "x" / "o")*
    { return link(undefined, false, "arrow", "solid", false, 1, { unsupported: true }); }

// The closing arrows of the inline-label form, as full-length shaft runs. Any
// shaft length is one closing arrow (`-->`, `--->`, `---->`, … / `==>`, `===>`,
// `====>`, …) — the same length-variant family the bare-arrow `"--" "-"* ">"`
// rule (above) accepts. The label rules use these as a negative lookahead so the
// label STOPS at the first char of the closing shaft run instead of leaking the
// extra shaft chars (`label='text -'`) — and the Link rule consumes the whole run.
DashArrowClose  = "--" "-"* ">"
ThickArrowClose = "==" "="* ">"

// The HEAD-LESS closing run of a labeled OPEN link (`---`, `--`, `----`, … /
// `===`, `==`, `====`, …) — a full-length dash/equals shaft with NO trailing `>`.
// The `!">"` after the greedy shaft run is what distinguishes an open-link close
// from an arrow close: a run that DOES reach `>` is an arrow and is claimed by
// DashArrowClose/ThickArrowClose (tried first in Link). Used both to consume the
// close in the labeled-open-link Link branch and as the label-run terminator
// lookahead (whitespace-delimited, so an embedded `--` inside a label is kept).
DashOpenClose  = "--" "-"* !">"
ThickOpenClose = "==" "="* !">"

// v1.6 #1b — the HEAD-LESS close of a LABELED inline edge requires ≥3 dash/equals
// chars (`---`/`===`+), NOT 2. REAL Mermaid rejects a 2-char head-less close on a
// labeled edge (`A -- lbl -- B` → error) but renders a 3+-char one (`A -- lbl --- B`).
// Distinct from the bare-arrow `DashOpenClose` (`--`+, used by the unlabeled open
// link `A --- B`) — only the labeled inline form has the ≥3 minimum.
InlineDashOpenClose  = "--" "-"+ !">"
InlineThickOpenClose = "==" "="+ !">"

// v1.6 #1b — the inline-label run terminator: an upcoming dash/equals run of ≥2 chars
// (whether glued or spaced). REAL Mermaid lexes a 2+-dash run inside what looks like a
// label as a LINK, not label text. `A -- a---b ---- B` → the glued `---` after `a` is a
// link: the label is `a`, `b` is the next node (A -[a]-> b, b → B). `A -- a--b --- B` →
// the glued `--` after `a` is a 2-dash run that is neither a ≥3 open close nor an arrow
// → the inline arm fails → reject (Mermaid rejects it too). A SINGLE dash (`a-b`) is
// label text and does NOT terminate. The leading `Sp` lets a spaced close terminate
// (`A -- lbl --- B`). The close arms (InlineDash{Arrow,Open}Close) then claim the run.
InlineDashLink  = Sp "--"
InlineThickLink = Sp "=="

// The CLOSE half of an inline-dotted labeled edge — a dotted-shaft run that BEGINS
// with `.` (the label having consumed everything between the `-.` opener and here).
// DotArrowClose (`.->`, `..->`, …) ends in `>` so it is unambiguous even glued to the
// label; DotOpenClose (`.-`, `..-`, …) is head-less (`!">"`) and so MUST be
// whitespace-delimited from the label (enforced by the `WS DotOpenClose` lookahead in
// InlineDotLabel + the Link arm) so a `.-` glued inside the label is kept as content.
// These are SEPARATE from the bare-dotted Link arms (`-." "."* "->"`) — there the `-.`
// opener and the close are one contiguous shaft; here the label splits them.
DotArrowClose = "." "."* "->"
DotOpenClose  = "." "."* "-" !">"

// A DOTTED close shaft (`.->`, `.-`, `..->`, …) — the close half of a dotted edge,
// as the bare-arrow rules accept it (`-." "."* "->"` / `"-." "."* "-"`). Used ONLY by
// the mixed-shaft detection branches as the "foreign close is dotted" case (e.g.
// `A -- label .-> B`). A genuine MATCHED dotted edge (`-.->`) has no separate inline
// label in this grammar, so DotClose is never a MATCHED-shaft close here.
DotClose = "." "."* "-" ">"? / "-." "."* "-" ">"?

// The label run for the MIXED-shaft detection branches: any chars up to (but not
// including) the first WHITESPACE-DELIMITED shaft close of ANY style (dash / thick /
// dotted) so the foreign close is left for the branch to match (and reject). Stops at
// a newline so it never spans lines.
MixedShaftLabel
  = chars:(!(WS (DashArrowClose / DashOpenClose / ThickArrowClose / ThickOpenClose / DotClose)) !"\n" c:. { return c; })+
    { return chars.join("").trim(); }

// An inline-dash / inline-thick edge label: a QUOTED run (quotes stripped, like
// PipeLabel) or a raw unquoted run. The raw form may not START with the head of
// the closing arrow (`>`/`-` for dash, `>`/`=` for thick — that would mean the
// leading `--` was really an arrow head, e.g. `A-->B` must NOT read as `A --[>B]`)
// and never spans an arrow terminator: it stops at the first char of the closing
// shaft run (`WS? DashArrowClose`), so ANY shaft length closes cleanly and internal
// hyphens/equals/pipes inside the label are preserved (only a run that actually
// reaches `>` is a terminator). The first raw char also may not be `|`: a
// `--|label|-->` / `==|label|==>` is the pipe-label form glued to the arrow, NOT an
// inline-dash label — excluding `|` makes this branch decline so the arrow's
// `PipeLabel?` (`-->|label|`) fires and strips the pipes instead of leaking them.
// Quoted forms (`-- "label" -->`, `== 'label' ==>`) strip the surrounding quotes,
// mirroring PipeLabel, so a quoted inline label never keeps its quote chars.
// The label stops at the closing shaft run. The terminator is `InlineDashLink`
// (`Sp "--"`) — ANY dash run of ≥2 chars, glued OR spaced (v1.6 #1b). This makes the
// run stop at a glued embedded link the way Mermaid lexes it: `A -- a---b ---- B` →
// the glued `---` after `a` is a link, so the label is `a` and `b` is the next node
// (NOT one edge labeled `a---b`); `A -- a--b --- B` → the glued `--` is a 2-dash run
// that fails the ≥3 open close (and is no arrow) → the arm declines → reject, exactly
// like Mermaid. A SINGLE dash (`a-b`) does NOT terminate (it is 1 char, not `--`), so
// internal single hyphens are kept. The first raw char also may not be `>`/`-`/`|`/NL:
// a leading `-` would belong to the close; a leading `>` is the arrow head; a leading
// `|` is the pipe-label form (`-->|label|`) the arrow's `PipeLabel?` must claim.
InlineDashLabel
  = '"' c:DQuoted '"' { return c; }
  / "'" c:SQuoted "'" { return c; }
  / first:(!InlineDashLink !(">" / "-" / "|" / "\n") c:. { return c; })
    rest:(!InlineDashLink !"\n" c:. { return c; })*
  { return (first + rest.join("")).trim(); }
InlineThickLabel
  = '"' c:DQuoted '"' { return c; }
  / "'" c:SQuoted "'" { return c; }
  / first:(!InlineThickLink !(">" / "=" / "|" / "\n") c:. { return c; })
    rest:(!InlineThickLink !"\n" c:. { return c; })*
  { return (first + rest.join("")).trim(); }
// The inline-DOTTED edge label between a `-.` opener and a `.->`/`.-` close, the exact
// parallel of InlineDashLabel for the dotted shaft. QUOTED forms strip the surrounding
// quotes (mirroring PipeLabel). The raw form may not START with `>`/`.`/`-`/`|`: a
// leading `.`/`-` would belong to the closing dotted shaft (so `-.-> B` is NOT read as
// `-.[ -> B ]`), a leading `>` is the arrow head, and a leading `|` is the pipe-label
// form (`-.->|label|`) which the arrow's `PipeLabel?` must claim instead. The run never
// spans a terminator: it stops at the first char of the close — `Sp DotArrowClose` (the
// `>` makes the arrow close unambiguous even glued) or `WS DotOpenClose` (the head-less
// close MUST be whitespace-delimited so a `.-` glued inside the label is preserved).
InlineDotLabel
  = '"' c:DQuoted '"' { return c; }
  / "'" c:SQuoted "'" { return c; }
  / first:(!(Sp DotArrowClose) !(WS DotOpenClose) !(">" / "." / "-" / "|" / "\n") c:. { return c; })
    rest:(!(Sp DotArrowClose) !(WS DotOpenClose) !"\n" c:. { return c; })*
  { return (first + rest.join("")).trim(); }

// ─── Whitespace / lines ─────────────────────────────────────────────────────────

Sp "inline space" = [ \t]*
WS "whitespace"   = [ \t]+
_nl               = [ \t\n\r]*
NL                = "\r\n" / "\n"
RestOfLine        = (!"\n" .)*
InlineComment     = "%%" (!"\n" .)*
EOF               = !.
