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
    //     matching the bare-truncated arm the corpus already certifies.
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
        // Hyphen-truncated shaped id — bound to the kept id, like the bare arm.
        endChar = keptIdEnd;
        labelStart = keptIdEnd;
        labelEnd = keptIdEnd;
      } else {
        endChar = s.endChar;
        labelStart = shapeInfo.labelStart;
        labelEnd = shapeInfo.labelEnd;
      }
    }
    return {
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
  }

  function makeEdge(from, to, label, loc) {
    const s = span(loc);
    return {
      kind: "edge",
      from,
      to,
      label: (label === null || label === undefined) ? undefined : label,
      line: s.line,
      startChar: s.startChar,
      endChar: s.endChar,
    };
  }

  // The set of flowchart keywords that may never be a node id (per the input
  // contract: ids are never a reserved keyword). Matched case-insensitively.
  const RESERVED = new Set([
    "graph", "flowchart", "subgraph", "end", "direction",
    "click", "class", "classdef", "style", "linkstyle", "default",
  ]);
  function isReserved(id) {
    return RESERVED.has(id.toLowerCase());
  }

  // Build a shape descriptor from open/close tokens + a label result. `l` is the
  // { value, quote, labelStart, labelEnd } from a ShapeLabel/AsymLabel rule.
  function shape(open, close, l) {
    return {
      open,
      close,
      shape: open + close,
      label: l.value,
      quote: l.quote,
      labelStart: l.labelStart,
      labelEnd: l.labelEnd,
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
    return {
      supported: true,
      diagramType: header.raw,
      keyword: header.keyword,
      direction: header.direction,
      nodes: body.nodes,
      edges: body.edges,
      subgraphs: body.subgraphs,
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
    for (const ln of lines) {
      if (!ln) continue;
      for (const n of ln.nodes) nodes.push(n);
      for (const e of ln.edges) edges.push(e);
      for (const sg of ln.subgraphs) subgraphs.push(sg);
    }
    return { nodes, edges, subgraphs };
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
  / ReservedNodeStmt                         { return null; }    // standalone reserved-keyword node — dropped, surroundings survive
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
ReservedNodeStmt
  = Sp "end" !IdChar NodeShape Sp InlineComment? (NL / EOF)         // shaped `end[X]` only (bare `end` = subgraph terminator)
  / Sp NonEndReservedKeyword !IdChar NodeShape? Sp InlineComment? (NL / EOF)

NonEndReservedKeyword
  = "graph" / "flowchart" / "subgraph" / "direction"
  / "click" / "classDef" / "class" / "linkStyle" / "style" / "default"

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
SingleLineBody
  = Sp content:StmtContent Sp InlineComment? { return content; }

StmtContent
  = SemicolonStmts
  / s:SingleStmt Sp ";"? { return s; }   // a single statement, optional trailing `;`

// `A --> B ; C --> D` — split on a top-level `;` (a `;` inside a pipe/inline
// label can't appear here because labels are matched as opaque runs). A trailing
// `;` with nothing after it is allowed (`A --> B;`).
SemicolonStmts
  = first:SingleStmt rest:(Sp ";" Sp s:SingleStmt { return s; })+ Sp ";"?
  {
    const acc = { nodes: [...first.nodes], edges: [...first.edges], subgraphs: [] };
    for (const s of rest) {
      acc.nodes.push(...s.nodes);
      acc.edges.push(...s.edges);
    }
    return acc;
  }

SingleStmt
  = EdgeChain
  / NodeStmt

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
    // A positioned, content-exclusive span for the title content (when the header
    // has a title) — for a title editor to target without rebuilding the line.
    if (h.titleSpan) {
      sgNode.titleStart = h.titleSpan.titleStart;
      sgNode.titleEnd = h.titleSpan.titleEnd;
    }
    return { nodes, edges, subgraphs: [sgNode, ...subgraphs] };
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
    { return { id: idl.value, title: title.value, quote: title.quote, idLoc: idl.loc, titleSpan: title.span }; }
  / t:SubgraphTitle &EndOfHeader
    { return { id: null, title: t.value, quote: t.quote, idLoc: t.loc, titleSpan: t.span }; }
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
SubgraphTitle
  = "[" cLoc:HERE '"' c:DQuoted '"' "]" { return { value: c, quote: '"', span: contentSpan(c, cLoc), loc: location() }; }
  / "[" cLoc:HERE "'" c:SQuoted "'" "]" { return { value: c, quote: "'", span: contentSpan(c, cLoc), loc: location() }; }
  / "[" cLoc:HERE c:BracketRun "]"      { return { value: c.trim(), quote: "", span: trimmedSpan(c, cLoc), loc: location() }; }
  / "(" cLoc:HERE '"' c:DQuoted '"' ")" { return { value: c, quote: '"', span: contentSpan(c, cLoc), loc: location() }; }
  / "(" cLoc:HERE "'" c:SQuoted "'" ")" { return { value: c, quote: "'", span: contentSpan(c, cLoc), loc: location() }; }
  / "(" cLoc:HERE c:ParenRun ")"        { return { value: c.trim(), quote: "", span: trimmedSpan(c, cLoc), loc: location() }; }
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

EdgeChain
  = first:NodeRef rest:(seg:EdgeSeg { return seg; })+
  {
    const out = { nodes: [], edges: [], subgraphs: [] };
    const emitNode = (ref) => {
      if (ref.shapeInfo && !isReserved(ref.id)) {
        out.nodes.push(makeNode(ref.id, ref.shapeInfo, ref.loc, ref.shapeLoc));
      }
    };
    emitNode(first);
    let prev = first;
    for (const seg of rest) {
      emitNode(seg.node);
      if (!isReserved(prev.id) && !isReserved(seg.node.id)) {
        const link = seg.link;
        const [from, to] = link.reversed
          ? [seg.node.id, prev.id]
          : [prev.id, seg.node.id];
        // edge span: from the previous node start to this node end.
        const loc = { start: prev.loc.start, end: seg.node.loc.end };
        out.edges.push(makeEdge(from, to, link.label, loc));
      }
      prev = seg.node;
    }
    return out;
  }

// A segment = arrow, optional pipe label, then the next node. A pipe label
// (`-->|yes|`) takes precedence over an inline-dash label if both somehow appear.
EdgeSeg
  = Sp link:Link Sp pipe:PipeLabel? Sp node:NodeRef
  {
    const label = pipe !== null && pipe !== undefined ? pipe : link.label;
    return { link: { label, reversed: link.reversed }, node };
  }

PipeLabel
  = "|" '"' c:DQuoted '"' "|" { return c; }
  / "|" "'" c:SQuoted "'" "|" { return c; }
  / "|" c:PipeRun "|"         { return c.trim(); }

PipeRun = chars:(!("|" / "\n") c:. { return c; })* { return chars.join(""); }

// ─── A single bare node / shaped node on its own line ─────────────────────────

NodeStmt
  = ref:NodeRef &{ return !isReserved(ref.id); }
  {
    return { nodes: [makeNode(ref.id, ref.shapeInfo, ref.loc, ref.shapeLoc)], edges: [], subgraphs: [] };
  }

// ─── Node reference (id, optionally with a shape) ─────────────────────────────

NodeRef
  = loc:HERE id:NodeId shapeLoc:HERE shape:NodeShape
    { return { id, shapeInfo: shape, shapeLoc, loc: { start: loc.start, end: location().end } }; }
  / loc:HERE id:NodeId
    { return { id, shapeInfo: null, loc: { start: loc.start, end: location().end } }; }

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
// arrow context).
PlainId "plain id"
  = first:[A-Za-z_] rest:[A-Za-z0-9_\-]*
  { return first + rest.join(""); }

// ─── Node shapes ──────────────────────────────────────────────────────────────
// Multi-char opening tokens are tried before single-char ones. Each returns the
// shape token pair, the label content, the quote char, and the content span.

NodeShape
  = "[[" l:ShapeLabel "]]" { return shape("[[", "]]", l); }
  / "[(" l:ShapeLabel ")]" { return shape("[(", ")]", l); }
  / "([" l:ShapeLabel "])" { return shape("([", "])", l); }
  / "((" l:ShapeLabel "))" { return shape("((", "))", l); }
  / "{{" l:ShapeLabel "}}" { return shape("{{", "}}", l); }
  / "["  l:ShapeLabel "]"  { return shape("[", "]", l); }
  / "("  l:ShapeLabel ")"  { return shape("(", ")", l); }
  / "{"  l:ShapeLabel "}"  { return shape("{", "}", l); }
  / ">"  l:AsymLabel  "]"  { return shape(">", "]", l); }

// ShapeLabel returns { value, quote, labelStart, labelEnd } — the content span is
// captured around the inner content so labelStart/labelEnd are real columns.
//
// The unquoted run must NOT begin with an opening bracket char (`[`/`(`/`{`).
// That guard closes the ASYMMETRIC over-bracket class (`A[[[hello]]`, `A((x)`,
// `A{{{x}}`, …): when a multi-char opener like `[[` fails to find its symmetric
// close, the single-char opener `[` would otherwise backtrack and swallow the
// leftover `[` as label content (`label:'[hello'`) — a silent corruption that
// the contract forbids (off-contract input must be warned, never silently corrupted). With the guard the whole node shape fails to match, so
// the block is reported `supported:false` + `parseError` (a clean WARN). A label
// that genuinely starts with a bracket must be quoted (`A["[x"]`), which the
// quoted alternatives above accept.
ShapeLabel
  = lLoc:HERE '"' c:DQuoted '"' { return labelSpan(c, '"', lLoc, location()); }
  / lLoc:HERE "'" c:SQuoted "'" { return labelSpan(c, "'", lLoc, location()); }
  / lLoc:HERE !OpenBracket c:BracketRun { return labelSpanRaw(c, "", lLoc); }

// An opening bracket char — used as a negative lookahead so an unquoted shape
// label can never begin with one (the asymmetric over-bracket corruption guard).
OpenBracket = "[" / "(" / "{"

// The `>]` (asymmetric) shape, like every other shape, must strip surrounding
// quotes so a quoted label reports quote='"'/"'" and a content-EXCLUSIVE span —
// otherwise a relabel honoring labelStart/labelEnd would silently drop the quotes
// (`A>"x"]` → `A>new]`). Mirror ShapeLabel: try the quoted forms first, then the
// raw unquoted run.
// The unquoted run gets the SAME `!OpenBracket` guard ShapeLabel has, for the
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

// Raw label runs — opaque text up to the (unquoted) close token / newline.
// A `%%` inside a label is content, not a comment, so it is NOT excluded here.
BracketRun = chars:(!("]" / ")" / "}" / "\n") c:. { return c; })* { return chars.join(""); }
AsymRun    = chars:(!("]" / "\n") c:. { return c; })* { return chars.join(""); }
// An unquoted subgraph-title run inside `(...)` — opaque up to the close paren.
ParenRun   = chars:(!(")" / "\n") c:. { return c; })* { return chars.join(""); }

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
  = "--" WS? l:InlineDashLabel WS? DashArrowClose { return { label: l, reversed: false }; }
  / "==" WS? l:InlineThickLabel WS? ThickArrowClose { return { label: l, reversed: false }; }
  // Labeled OPEN-link (NO arrowhead): `A -- label --- B`, `A -- label -- B`,
  // `A -- label ---- B` (and the thick `A == label === B` variants). Mirrors the
  // labeled-arrow branches above, but the CLOSE is a head-less dash/equals run
  // (`DashOpenClose`/`ThickOpenClose` = `-- -* !">"` / `== =* !">"`). Without these
  // branches the labeled-open-link FALSE-GREENED: the labeled-arrow branch needs a
  // trailing `>`, so it declined; Peggy backtracked to the bare `--` open link and
  // re-read the single-token label as a NodeRef — fabricating a phantom node + two
  // edges (`A→label`, `label→B`) with NO warning. Emitting ONE labeled open-link
  // edge here keeps the model correct. The close must be whitespace-delimited from
  // the label (the label-run lookahead requires `WS DashOpenClose`), so an embedded
  // `--`/`---` glued inside the label (`a--b`, `a---b`) is preserved, not read as a
  // close. GENERALIZES the inline-dash family across {close-kind: arrow vs open} ×
  // {shaft-length 2..5} × {label: quoted/unquoted} — every arm now parses to ONE
  // labeled edge instead of phantom-noding.
  / "--" WS? l:InlineDashLabel WS DashOpenClose { return { label: l, reversed: false }; }
  / "==" WS? l:InlineThickLabel WS ThickOpenClose { return { label: l, reversed: false }; }
  // Bidirectional (solid only — Mermaid has no `<==>`).
  / "<-->" { return { label: undefined, reversed: false }; }
  / "<--"  { return { label: undefined, reversed: true }; }
  // Thick, with shaft length variants (`==>`, `===>`, `====>`). Routed through
  // ThickArrowClose ("==" "="* ">", any shaft length ending in `>`) so the bare
  // thick arrow accepts every length the labeled-thick form already does — mirror
  // of the bare-dash `"--" "-"* ">"` path below. (Tried before the headless
  // `===`/`====` open link so a trailing `>` is always claimed as the arrow head.)
  / ThickArrowClose { return { label: undefined, reversed: false }; } // `==>`, `===>`, `====>`
  / "===" "="* { return { label: undefined, reversed: false }; } // `===`, `====`, … (open link, no head)
  // Dotted (length variants `-.->`, `-..->`).
  / "-." "."* "->" { return { label: undefined, reversed: false }; }
  / "-." "."* "-"  { return { label: undefined, reversed: false }; }
  // Solid arrow / open link, with length variants (`-->`, `--->`, `---`, `----`).
  / "--" "-"* ">"  { return { label: undefined, reversed: false }; }
  / "--x"          { return { label: undefined, reversed: false }; }
  / "--o"          { return { label: undefined, reversed: false }; }
  / "--" "-"+      { return { label: undefined, reversed: false }; } // `---`, `----`
  / "--"           { return { label: undefined, reversed: false }; } // bare open `--`

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
// The label stops at the closing shaft run. Two terminator shapes:
//   - `Sp DashArrowClose` — an arrow close (`-->`), any spacing incl. glued, as
//     before (the `>` makes it unambiguous even with no space).
//   - `WS DashOpenClose`  — a head-less open close (`---`), which MUST be
//     whitespace-delimited from the label. Requiring `WS` (not `Sp`) here is what
//     keeps an embedded `--`/`---` glued inside the label (`a--b`, `a---b`) from
//     being misread as a close — only a whitespace-separated dash run terminates.
InlineDashLabel
  = '"' c:DQuoted '"' { return c; }
  / "'" c:SQuoted "'" { return c; }
  / first:(!(Sp DashArrowClose) !(WS DashOpenClose) !(">" / "-" / "|" / "\n") c:. { return c; })
    rest:(!(Sp DashArrowClose) !(WS DashOpenClose) !"\n" c:. { return c; })*
  { return (first + rest.join("")).trim(); }
InlineThickLabel
  = '"' c:DQuoted '"' { return c; }
  / "'" c:SQuoted "'" { return c; }
  / first:(!(Sp ThickArrowClose) !(WS ThickOpenClose) !(">" / "=" / "|" / "\n") c:. { return c; })
    rest:(!(Sp ThickArrowClose) !(WS ThickOpenClose) !"\n" c:. { return c; })*
  { return (first + rest.join("")).trim(); }

// ─── Whitespace / lines ─────────────────────────────────────────────────────────

Sp "inline space" = [ \t]*
WS "whitespace"   = [ \t]+
_nl               = [ \t\n\r]*
NL                = "\r\n" / "\n"
RestOfLine        = (!"\n" .)*
InlineComment     = "%%" (!"\n" .)*
EOF               = !.
