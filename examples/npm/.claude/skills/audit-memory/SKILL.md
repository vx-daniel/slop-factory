---
name: audit-memory
description: >-
  Audit the committed durable agent-memory corpus (`.claude/memory/`) and propose distilling
  recurring themes into `.claude/rules/` — the synthesis half of the agent-memory system. Use
  when the user asks to audit / clean / dedup / synthesize memory, "distill memories into rules",
  "run the auditor", asks why N memories say the same thing, or when the corpus has grown enough
  that bloat or staleness is a problem. PROPOSE-ONLY: it never auto-writes a rule or deletes a
  memory — it produces a proposal a human approves. Governed by `.claude/rules/agent-memory.md`.
---

# Audit Memory (the auditor — propose-only)

The export skill makes durable memories portable; this skill keeps the corpus *clean* and turns
recurring themes into the channel agents actually enforce — `.claude/rules/`. It is the judgment
layer, so it is **propose-only by construction**: it writes a proposal to `.local/`, a human
approves, and applying the approved rules is a separate, explicit step. Distilling memory into an
always-on rule is the highest-blast-radius action in this repo (every session and the CI reviewer
load rules) — the same propose-don't-auto-act posture `agent-memory.md` states: surface, don't auto-act.

The audience is **agents**. Optimize proposals for the next agent's recall and for context cost.

## Step 1 — gather the mechanical signals

Two helpers give you the signals you must consult before proposing anything. Run both:

```bash
node .claude/skills/audit-memory/scripts/scan-currency.mjs      # which memories are stale/superseded
node .claude/skills/audit-memory/scripts/existing-coverage.mjs  # what's already a rule; which memories say so
```

- **`scan-currency`** flags supersession language ("superseded", "OVERTURNED", "no longer true").
  It **over-flags on purpose** ("stale branches", a "deprecated" code comment will hit) — that bias
  is correct for a gate. Treat each hit as "read this in full," not "this is stale."
- **`existing-coverage`** lists the rule inventory (with scope: `always_on` / `path-scoped`) and the
  memories that declare themselves promoted (they point at a shipped `.claude/rules/` file) — that
  cluster is already covered; do not re-propose it.

## Step 2 — cluster the durable memories by theme

This is judgment. Use the structural signals the corpus hands you: the `[[wikilink]]` graph
(co-cited memories are usually one theme) and shared topic. A cluster is a set of memories that
would collapse into one principle. Name each cluster in one line.

## Step 3 — for each cluster, walk four gates (in order)

1. **Currency-gate.** If any member is flagged by `scan-currency`, read it in full and identify the
   *current* truth before anything in the cluster feeds a rule. If members conflict and none clearly
   wins, **surface the conflict** — do not average across them. (Distilling a self-superseding cluster
   bakes a reverted decision into an always-on gate — the worst failure mode here.)
2. **Coverage-gate.** From `existing-coverage`: is this already a rule? Fully covered → **skip**.
   Partially → propose an **update** to the existing rule, not a new one. Net-new → continue.
3. **Route — consumer × modality.** Pick the destination by *who consumes it* and *how*. This is the
   crux: an authoring-behavior cluster turned into an `always_on` rule becomes **reviewer noise** (the
   CI reviewer loads every rule). Route deliberately:

   | Cluster is about… | Destination | Why |
   |---|---|---|
   | reviewing a diff (correctness, wire/firmware contract, tests) | **path-scoped rule** (`paths:` for the relevant files) | CI reviewer auto-loads it exactly when reviewing those files; out of context otherwise |
   | a universal authoring principle (verify-before-claim, no magic values) | **`always_on` rule** | genuinely applies to every change |
   | workflow/process (git hygiene, AskUserQuestion, plans-location) | **CLAUDE.md section** or **stays memory** | useful to authors, *noise* as a review rule — keep it out of `.claude/rules/` |
   | a multi-step procedure | **skill** | loads on demand, not every session |

4. **Draft + provenance.** Draft the artifact (rule text with frontmatter matching the repo
   convention — `trigger_phrase`, `paths`/`always_on`; or a CLAUDE.md section). Carry **provenance**:
   cite the source memories and the incidents they cite (PR#/date) — a well-sourced rule names its
   originating incident. A rule with no traceable "why" rots like an unsourced memory.

## Step 4 — write a DECISION-READY proposal

Write one report to `.local/plans/memory-audit-<date>.md`. Each actionable recommendation is a block
the review step can act on directly — it carries an editable decision header:

```markdown
### C4 — Git/PR workflow → CLAUDE.md section
Decision: pending        # set to: approve | deny | edit
Notes:                   # optional — deny reason, or your replacement text if Decision: edit
Members: <source memories>
Verdict: currency <ok | gated: …> · coverage <net-new | update <rule> | covered → skip> · route <dest — one-line why>

<the drafted artifact, inline, EXACTLY as it would land — the user reviews content, not a summary>
```

At the end list, separately: clusters **skipped** (already covered — name the covering rule/skill) and
**dedup** opportunities (N memories that collapse into one principle). Do NOT write to `.claude/rules/`,
edit `CLAUDE.md`, or delete any memory in this step.

## Step 5 — review: interactive walk-through (default)

Walk the user through the proposal **one recommendation at a time** — never batch them into a single
prompt. A single `AskUserQuestion` multiselect across *all* recommendations loses the artifact and the
per-item decision; present each recommendation's artifact in prose, then capture *its* decision on its own.
For each recommendation:

1. **Present it** — members, the currency/coverage/route verdict, and the drafted artifact **inline** so
   the user sees exactly what would land.
2. **Ask the decision via `AskUserQuestion`** — one question (approve / deny / edit), phrased in plain,
   forward language a junior developer could answer confidently. Agents lapse into jargon or reference
   other-agent / PR context the user wasn't part of, so the structured, plainly-worded question is what
   keeps the user genuinely in the loop — it is not optional ceremony. Give your one-line recommendation
   alongside it.
3. **Record** their answer into the proposal file's `Decision:` (and `Notes:` for a deny reason or an edit).
4. **Advance** to the next. Confirm the **skips** as a single batch at the end (no action — already covered).

Async alternative: the user sets every `Decision:` field in the file directly, then invokes Step 6. The
file is the source of truth either way — the walk-through just fills it conversationally.

## Step 6 — apply (only on explicit go-ahead)

Read the decisions and act, one cluster at a time, each its own reviewable change:

- **approve / edit** → make the change (add the `CLAUDE.md` section, or write/update the rule), update the
  memory index, and retire the subsumed memories — **delete the file** (git history preserves it; its
  content now lives in the artifact), not leave a zombie or move it to an archive dir.
  Land it on a branch → **PR**, so the final diff gets the normal review + CI. Use the user's text for `edit`.
- **deny** → no change; record the denial + reason in the proposal so a future audit doesn't re-propose it.
- **Sequence around open PRs.** If a change edits a file an open PR also edits (e.g. `CLAUDE.md`), branch off
  the updated `main` *after* that PR merges — never base a PR on another open PR's branch (it orphans
  commits when that PR squash-merges).

Applying is never automatic — it waits for the user's go-ahead after the walk-through.

## Hard rules

- **Propose-only.** Never auto-create a rule or delete a memory. The user approves promotion.
- **Currency-gate every cluster.** Never distill across a flagged/self-superseding cluster.
- **Promotion-aware.** Never re-propose what `existing-coverage` shows is shipped; update instead.
- **Route, don't dump.** Authoring/workflow clusters do not become `always_on` rules.
- **Provenance always.** Every proposed rule cites its source memories + incidents.

## Boundaries

Dedup and re-sort (durable↔current) and archival of spent `temp/` memories are part of the auditor's
hygiene remit — surface them in the proposal, but apply only on approval. Realizing the local
two-index split and `temp/` sync are separate (sync skill / roadmap), not this skill's job.
