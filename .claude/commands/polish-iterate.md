---
description: One autonomous design→build→test→check pass of the Marketplace polish loop (self-driving; stops only at a REVIEW-GATE)
argument-hint: "[optional: roadmap item id e.g. IT-3, or a directive]"
---

You are running ONE autonomous pass of the **design → build → test → check** polish loop for this VS Code extension. You are invoked repeatedly by `/loop /polish-iterate` with NO human in the inner loop — the operator is the **FINAL REVIEW GATE only**. Do not ask the operator to drive or approve routine work; keep going on your own until you legitimately hit a review gate.

The loop's durable memory is `POLISH-STATE.md` at the repo root. Read it first, every pass.

## 0 · GATE CHECK
Read `POLISH-STATE.md`. If the top `STATUS:` marker shows an open gate (`GATE:` is not `none`), do NOT do any work — only the operator clears it. Print: `Paused at REVIEW-GATE: <name>. Awaiting your design + bug feedback (see the REVIEW PACKET in POLISH-STATE.md).` and END the pass (if under `/loop`, end the loop — do not reschedule).

## 1 · DESIGN
Pick the work item: if `$ARGUMENTS` names one (e.g. `IT-3`) use it; otherwise take the topmost roadmap item whose status is not `DONE`. Restate and, if vague, sharpen its acceptance criteria.

## 2 · BUILD
Implement exactly that item. Keep `src/parser.ts` and `src/editor.ts` free of the `vscode` module (push vscode types into `panel.ts`) — see project CLAUDE.md. Match the surrounding code style.

## 3 · TEST (fast gate — must stay green)
Run `npm run typecheck`, `npm test`, `npm run compile`. If any fail, fix and re-run. NEVER advance to CHECK on a red gate. If the SAME failure survives 3 honest attempts, open a REVIEW-GATE (stuck) and end.

## 4 · CHECK (deep verification, matched to the item)
- Runtime / visual items → run the `@vscode/test-electron` smoke headless under `xvfb-run`; capture screenshots to `artifacts/`.
- Code items → `/code-review`; anything touching the webview or write-back → also `/security-review`.
- Packaging items → `npx @vscode/vsce package` (or `--dry-run`).
Report what you actually ran vs. what stays assumed (follow `~/verification-discipline.md`). Never claim "works" for something you did not run.

## 5 · COMMIT (green gate only)
Commit the pass to `main` — one roadmap item per commit, a Conventional Commits subject (`type(scope): description`; the `.githooks/commit-msg` hook hard-enforces it), and the Claude co-author trailer. Then `git push` to sync the remote and trigger CI. Never run `vsce publish` (operator-only).

## 6 · DECIDE — continue or gate
Update `POLISH-STATE.md`: mark the item's status; add CHECK findings as new backlog items; append a dated block to the Iteration log; tick the publish-ready checklist; update the top `STATUS:` marker.

Open a **REVIEW-GATE** — set `GATE: <name>`, append a REVIEW PACKET to the log, and END the loop — if the pass hit ANY gate condition in POLISH-STATE.md's "Review-gate protocol": a design/taste call, an unresolved bug, a milestone (`.vsix` staged or IT-1 screenshots ready), a step that failed ≥3 passes, or any outward-facing/destructive action.

Otherwise set `GATE: none`, give a one-line summary of the pass, and CONTINUE — the next pass picks up the next item automatically.
