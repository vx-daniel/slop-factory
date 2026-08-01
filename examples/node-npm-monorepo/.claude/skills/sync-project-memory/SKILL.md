---
name: sync-project-memory
description: >-
  Commit durable agent memories from the machine-local auto-memory dir into the in-repo
  `.claude/memory/` so they become version-controlled and shareable instead of trapped on
  one machine — the EXPORT half of the "mind-meld" sync. Use it whenever the user wants to
  attach / publish / commit / share agent memory to the repo, asks to "run the mind-meld",
  asks why memories aren't shared with teammates or the CI reviewer, or after a working
  stretch that produced durable learnings worth committing. This skill is the export half: it STAGES
  the durable corpus in the repo, which a `CLAUDE.md` `@import` then auto-loads in LOCAL Claude Code
  sessions (CI headless does not expand the import, so the CI reviewer `Read`s it explicitly in its
  workflow). It also builds the current-task index (`MEMORY_CURRENT.md` + `temp/` files); distillation is the separate `audit-memory` skill.
---

# Sync Project Memory (mind-meld — export)

Claude auto-memory is **machine-local** (`~/.claude/projects/<project>/memory/`) and never
travels — not to teammates, not to the CI PR reviewer that loads `CLAUDE.md` + `.claude/rules/`
in GitHub Actions. This skill mirrors the **durable** half of that memory into the committed
`.claude/memory/` so it travels with the repo. Governed by `.claude/rules/agent-memory.md`
(the two-index split: durable `MEMORY.md` vs current-task `MEMORY_CURRENT.md`).

**What this does and does not deliver today.** Committing the corpus makes it **shareable and
version-controlled**, and a `CLAUDE.md` `@import` of `.claude/memory/MEMORY.md` makes the durable index
**auto-load in local Claude Code sessions**. The **CI reviewer is headless and does NOT expand `@import`**
(`CLAUDE.md` reaches it as raw text), so it does not pick the index up automatically — its review
workflow `Read`s this index explicitly instead. Now also built: the current-task index
(`MEMORY_CURRENT.md` + `temp/` files). Still deferred: a local-dir merge-**import**.

See `.claude/rules/agent-memory.md` § "What actually loads, and when" for the same split stated as a
convention.

## When to run

- The user asks to publish / sync / share / attach agent memory to the repo, or "run the mind-meld".
- The CI reviewer or a teammate is missing context that lives only in local memory.
- After a stretch of work that produced durable principles/preferences worth committing.

Not for current-task status updates — those are `project`-type, stay in `MEMORY_CURRENT.md`, and
their shared copy is the GitHub issue/PR (per `agent-memory.md`).

## Procedure

1. **Dry-run first** — surface the partition before writing anything:
   ```bash
   node .claude/skills/sync-project-memory/scripts/export-memory.mjs
   ```
   It classifies each machine-local memory by filename prefix:
   - `feedback_*` / `user_* `/ `reference_*` → **durable** → exported to `.claude/memory/`
   - `project_*` → **current** → files to `.claude/memory/temp/`; index at `.claude/memory/MEMORY_CURRENT.md`
   - anything else → **unknown** → held and listed (never silently dropped)

2. **Read the plan.** Confirm the durable/current split looks right. If a `project_*` memory is
   actually a durable principle (or vice-versa), that's a misclassification — fix it at the source
   by renaming the file to the correct prefix, then re-run. (Deep re-sorting is the L3 auditor's job;
   for now the prefix is the contract.)

3. **Apply** once the plan is correct:
   ```bash
   node .claude/skills/sync-project-memory/scripts/export-memory.mjs --write
   ```
   This copies durable files into `.claude/memory/` and regenerates `.claude/memory/MEMORY.md`
   (durable index, with the persistent header re-asserted from `agent-memory.md`). It preserves
   curated index hooks from the source `MEMORY.md` where present; otherwise synthesizes from each
   file's frontmatter `description`.

4. **Review the diff, then commit.** `git status .claude/memory/` — these are agent-knowledge files,
   so commit them on their own focused commit (don't fold memory churn into a code PR). The script is
   non-destructive to the source dir; safe to re-run.

## Wiring the read path (close the loop)

Export only *stages* the corpus — for it to load, `CLAUDE.md` must `@import` the durable index.
Ensure that (idempotent — a no-op if already wired):

```bash
node .claude/skills/sync-project-memory/scripts/ensure-claude-import.mjs --write
```

Dry-run (no `--write`) reports present/missing without writing. Every local session and the CI
reviewer load `CLAUDE.md`, so this one import is what makes the committed corpus actually reach
them. Run it once per repo (or after any export); a future SessionStart hook can call it.

## Flags

- `--write` — apply (default is dry-run).
- `--source=DIR` — override the machine-local source (default: derived from the repo path).
- `--dest=DIR` — override the committed destination (default: `<repo>/.claude/memory`).
- `--help`.

## Boundaries (deliberately out of MVP scope)

- **Local-dir merge-import** (committed → your local dir) — L2, and likely unnecessary now the
  read path is the `CLAUDE.md` `@import`.
- **Auditor** (dedup, currency scan, distill durable → path-scoped rules) is the separate
  `audit-memory` skill (built) — not this skill's job.
- **CI memory-hygiene reminder** (prompt retiring a spent `temp/` note when its issue's PR lands) — not yet built.

Don't improvise them here. If you need one, design it deliberately and write the design down first —
these are the pieces most likely to be built badly under time pressure.
