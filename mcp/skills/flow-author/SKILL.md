---
name: flow-author
description: >-
  Writes and maintains Mermaid flowcharts that are clean, machine-parseable, and
  safe to edit. Assigns stable semantic node ids, labels every decision branch,
  groups phases as subgraphs, edits with the flow tools (so a rename propagates
  to every edge), and verifies the result before saving.
when_to_use: >-
  Use when creating a new Mermaid flowchart or editing an existing one (renaming
  a node id, changing a label, restructuring) so the diagram stays consistent and
  an agent can later read it as structured data. Pairs with flow-follow, which
  consumes flows. Flowcharts only.
paths:
  - "**/*.mmd"
  - "**/*.md"
allowed-tools: mcp__plugin_mermaid-node-editor-flows_flows__flow_overview, mcp__plugin_mermaid-node-editor-flows_flows__flow_extract, mcp__plugin_mermaid-node-editor-flows_flows__flow_query, mcp__plugin_mermaid-node-editor-flows_flows__flow_validate, mcp__plugin_mermaid-node-editor-flows_flows__flow_rename, mcp__plugin_mermaid-node-editor-flows_flows__flow_relabel
---

# flow-author — write machine-parseable Mermaid flows

Author and maintain Mermaid **flowcharts** (`graph` / `flowchart`) so they are consistent and another agent can read them as structured data through the flow tools. **Flowcharts only** — other diagram types are out of scope (the tools report them `supported: false`).

## Conventions (follow all)

1. **Stable semantic node ids** — the load-bearing rule. Never use opaque ids (`A`, `B`, `N1`). Derive each id from the node's role + label so it is meaningful *and* stable across re-authoring. See **the discriminator** below. `snake_case`, charset `[A-Za-z0-9_]` (no hyphens, no spaces). **Never name a node bare `end`** (a Mermaid keyword) — use `done` / `complete`. Emit `id[Label]`: the **id is the stable address**, the bracket label is the human display — e.g. `receive_order[Receive order]`.
2. **Label every decision branch.** A decision's outgoing edges carry the condition: `in_stock -->|yes| pack_items` and `in_stock -->|no| backorder`. An unlabeled branch is ambiguous to any reader.
3. **Subgraphs = phases.** Group a stage's nodes: `subgraph checkout [Checkout] … end`.
4. **One tag = one element.** Don't reuse an id for two nodes; don't declare the same node twice with different labels.
5. **Shape signals role.** `[]` step · `{}` decision · `()` / `([])` state or terminal · `[()]` store. The discriminator reads the shape.

## The naming discriminator (how to assign an id)

Two steps. **(1) the role decides the id form:**

| Role (shape + meaning) | Id form | Label → id |
|---|---|---|
| Action / process step `[]` | `verb_phrase` | "Receive order" → `receive_order` |
| Decision `{}` | the condition | "In stock?" → `in_stock` |
| State / entity / data `()` `([])` `[()]` | `noun` | "Order" → `order` |
| Terminal | `start` / outcome | "Complete" → `done` (never bare `end`) |
| Subgraph / phase | `phase_noun` | "Checkout" → `checkout` |

**(2) qualify by phase** for locality + uniqueness: a node inside a subgraph is phase-prefixed — `checkout_validate_cart`; standalone nodes stay bare. **Slug rules:** lowercase `snake_case`, drop stop-words, 2–4 load-bearing words. Collisions → phase-qualify → add a semantic distinguisher → `_2` only as a last resort.

The id is a **pure function of (role, label, phase)** — so regenerating or re-laying-out the diagram yields the **same** ids. That stability is what lets another agent reference a node by id across sessions.

## Procedure

1. Draft the flowchart following the conventions above.
2. For an **edit**, use the tools — never hand-edit an id by find-replace, you will miss edge references:
   - rename a node id → **`flow_rename`** (propagates to every edge automatically).
   - change a label → **`flow_relabel`** (preserves bracket shape + quoting).
3. **Always verify before saving:** **`flow_validate`** (catches duplicate ids, empty labels, unreachable nodes) → **`flow_extract`** read-back (confirm the parsed structure — node count, edges with their labels, subgraphs — is what you intended). Fix and re-verify until clean.

## Notes

- The write tools default to **returning the edited text**; they only touch disk with `write: true` on a file path. You decide when to persist.
- Generated flows are written for human/agent **review, never auto-executed**.
- Examples must be neutral / synthesized.
