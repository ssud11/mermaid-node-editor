# POLISH-STATE — Mermaid Node Editor → Marketplace

<!-- STATUS: not-started | next=IT-0 | GATE: none -->

Ledger + memory for the **autonomous** design → build → test → check → design polish loop. Survives across sessions; every `/polish-iterate` pass reads this file and updates it — including the `STATUS:` marker above (a `SessionStart` hook prints it so each new session knows where the loop is).

- **Driver:** SELF-DRIVING via `/loop /polish-iterate`. Passes run unattended. The operator is the **FINAL REVIEW GATE only** — design taste + bug sign-off. Claude does NOT stop every pass; it stops only at a REVIEW-GATE (protocol below).
- **Runtime verification (BOTH):** automated `@vscode/test-electron` smoke runs *inside* the loop under `xvfb-run` (headless) and captures screenshots to `artifacts/` → the operator does the visual / manual-F5 sign-off at a gate.
- **Polish scope:** full (theme-matched UI, GIF demo, integration suite, broad QA).
- **Publisher:** `ssud11` (operator has a Marketplace account). The loop's job ends at a built **`.vsix`**; publishing is operator-only and ALWAYS gated.

---

## The loop (one `/polish-iterate` pass)

| Station | What happens | Tooling |
|---|---|---|
| **GATE check** | If `STATUS:` shows an open `GATE:`, do no work — hand back to operator | this ledger |
| **DESIGN** | Pick topmost non-`DONE` roadmap item; confirm acceptance criteria | this ledger |
| **BUILD** | Implement it (code / assets / `package.json` metadata) | Edit/Write |
| **TEST** (fast gate, must stay green) | `npm run typecheck` · `npm test` · `npm run compile` | Bash (allowlisted) |
| **CHECK** (deep) | xvfb integration smoke + screenshots · `/code-review` · `/security-review` · `vsce package` | per item |
| **DECIDE** | Update ledger + `STATUS:`; CONTINUE to next pass, or open a REVIEW-GATE | this ledger |

---

## Review-gate protocol (when the loop hands back to YOU)

Open a GATE — set `STATUS: ... | GATE: <name>`, append a **REVIEW PACKET** to the iteration log, and END the loop — when a pass hits ANY of:

1. **Design / taste call** you should own — icon look, GIF content/length, theme & spacing choices, README copy tone.
2. **A bug the loop can't confidently fix** after an honest attempt (don't thrash).
3. **A milestone worth a checkpoint** — a built `.vsix`, or runtime/visual behaviour needing human eyes (IT-1 screenshots).
4. **Same TEST/CHECK step fails ≥3 passes** in a row (stuck — surface it, don't loop forever).
5. **Any outward-facing / destructive action** — `git push`, `vsce publish`, anything network/irreversible. ALWAYS gated; the loop never does these itself.

A **REVIEW PACKET** records: what was done, exactly what to look at, the design questions + suspected bugs, and where the evidence is (`artifacts/*.png`, `.vsix` path). Your feedback → new backlog items → set `GATE: none` → the loop resumes next pass.

If NONE of the above fire: update `STATUS:`, mark the item, and CONTINUE — the next pass starts on its own.

---

## Publish-ready checklist (definition of done)

- [ ] TEST gate green (typecheck + 22 unit tests + esbuild bundle)
- [ ] **Runtime — automated** `@vscode/test-electron` smoke passes headless under xvfb
- [ ] **Runtime — operator visual sign-off** at a gate (screenshots: label edit, ID rename→edge propagation, subgraph title, unsupported notice)
- [ ] `icon` field + `icon.png` (128×128)
- [ ] `repository` field in `package.json`
- [ ] `CHANGELOG.md`
- [ ] README has screenshot **and** animated GIF
- [ ] Theme-matched UI (`--vscode-*` tokens; clean empty/unsupported states)
- [ ] `/code-review` (high) + `/security-review` clean
- [ ] `vsce package` → `.vsix` builds, no warnings
- [ ] `git init` + clean history
- [ ] **[operator-only gate]** upload/publish the `.vsix` (web UI, or PAT + `vsce publish`)

---

## Iteration roadmap (full-polish ordering)

> Runtime truth first (can invalidate `panel.ts`/`main.js` assumptions), then lock with automation, then polish surface, then package, then harden.

### IT-0 — Baseline + git  · _status: TODO_
- Re-confirm TEST gate green from clean; `git init` + first commit; add `repository` field to `package.json`.
- **Accept:** green gate; repo initialised; `vsce package --dry-run` stops warning about missing repository. _(no gate — continue)_

### IT-1 — Runtime smoke + screenshots (xvfb)  · _status: TODO_
- Stand up a minimal `@vscode/test-electron` harness; launch the real extension host headless under `xvfb-run`; open [examples/demo.mmd](examples/demo.mmd); capture screenshots of: panel populated, label edit, ID rename, subgraph title, `sequenceDiagram` unsupported notice → `artifacts/`.
- Fix obvious breakage in [panel.ts](src/webview/panel.ts) / [main.js](src/webview/main.js).
- **Accept:** smoke launches; screenshots captured. → **REVIEW-GATE** (your visual/F5 sign-off on the 5 behaviours).

### IT-2 — Automated integration assertions  · _status: TODO_
- Extend the harness into real assertions: activation · webview message round-trip · `WorkspaceEdit` write-back lands · ID-rename edge propagation end-to-end. Wire `npm run test:integration`.
- **Accept:** integration suite passes headless. _(continue)_

### IT-3 — UI / theme polish  · _status: TODO_
- [style.css](src/webview/style.css) → `var(--vscode-*)` tokens, spacing, focus rings, hover, empty + unsupported states. Re-capture light+dark screenshots.
- **Accept:** native look both themes; no hard-coded colors. → **REVIEW-GATE** (design taste).

### IT-4 — Marketplace metadata + assets  · _status: TODO_
- `icon.png` (128×128) + `icon` field; `galleryBanner`; tidy categories/keywords; `CHANGELOG.md` (Keep-a-Changelog, `0.1.0`).
- **Accept:** `vsce package --dry-run` clean; icon renders. → **REVIEW-GATE** (icon design).

### IT-5 — README + GIF demo  · _status: TODO_
- Screenshot + animated GIF of the edit→write-back flow; feature list; install/usage; supported-shapes table; known limitations.
- **Accept:** README renders well as a Marketplace landing page. → **REVIEW-GATE** (copy + GIF taste).

### IT-6 — Hardening + final CHECK  · _status: TODO_
- `/code-review high` · `/simplify` · `/security-review` (verify CSP/nonce + no-innerHTML hold). Full sweep: typecheck + unit + integration + `vsce package` → `.vsix`.
- **Accept:** reviews clean; `.vsix` staged. → **REVIEW-GATE** (final sign-off → you publish).

---

## Iteration log (newest on top — REVIEW PACKETs land here)

_(empty — first `/polish-iterate` pass appends here)_
