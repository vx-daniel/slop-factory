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
   by renaming the file to the correct prefix, then re-run. (Deep re-sorting is the `audit-memory`
   skill's job; for this script the prefix is the contract.)

3. **Apply** once the plan is correct:
   ```bash
   node .claude/skills/sync-project-memory/scripts/export-memory.mjs --write
   ```
   This writes **both** halves of the split: durable files into `.claude/memory/` with a regenerated
   `.claude/memory/MEMORY.md`, and `project_*` files into `.claude/memory/temp/` with a regenerated
   `.claude/memory/MEMORY_CURRENT.md`. The durable index carries the persistent header, which lives as
   `DURABLE_INDEX_HEADER` in this script — that constant is the source of truth, and
   `.claude/rules/agent-memory.md` reproduces it for readers (a unit test holds the two identical).
   The index preserves curated hooks from the **source** `MEMORY.md` where present; otherwise it
   synthesizes from each file's frontmatter `description`.

4. **Review the diff, then commit.** `git status .claude/memory/` — these are agent-knowledge files,
   so commit them on their own focused commit (don't fold memory churn into a code PR). Safe to
   re-run: the source dir is never modified.

   Two things `--write` does **not** do, both of which matter when re-running. It regenerates the
   destination rather than merging into it, so a hand-edit to the committed `.claude/memory/MEMORY.md`
   is overwritten — curate in the source index instead. And there is no deletion pass: a memory
   removed at the source drops out of the regenerated index but its copied file stays behind, so
   delete that by hand.

## Wiring the read path (close the loop)

Export only *stages* the corpus — for it to load, `CLAUDE.md` must `@import` the durable index.
Ensure that (idempotent — a no-op if already wired):

```bash
node .claude/skills/sync-project-memory/scripts/ensure-claude-import.mjs --write
```

Dry-run (no `--write`) reports present/missing without writing. If `CLAUDE.md` does not exist the
script creates it; if it does, the section is inserted **above the first `## ` heading** rather than
appended. Run it once per repo (or after any export); a future SessionStart hook can call it.

This import is what reaches **local** sessions. It is not what reaches CI: the reviewer is headless
and does not expand `@import`, so its workflow `Read`s `.claude/memory/MEMORY.md` directly — and only
if this project was generated with the Claude workflows feature. See
`.claude/rules/agent-memory.md` § "What actually loads, and when".

## Flags

Per script — they do not share a parser, and passing one script another's flag is silently ignored
rather than rejected, so a typo looks like a successful dry-run.

`export-memory.mjs`:
- `--write` — apply (default is dry-run).
- `--source=DIR` — override the machine-local source (default: derived from the repo path, or the
  `MEMORY_SOURCE_DIR` environment variable if set).
- `--dest=DIR` — override the committed destination (default: `<repo>/.claude/memory`).
- `--help` / `-h`.

`ensure-claude-import.mjs`:
- `--write` — apply (default is dry-run).
- `--claude-md=PATH` — override the target (default: `<repo root>/CLAUDE.md`).
- `--help` / `-h`.

## Boundaries (deliberately out of MVP scope)

- **Local-dir merge-import** (committed → your local dir) — likely unnecessary now the read path is
  the `CLAUDE.md` `@import`.
- **Auditor** (dedup, currency scan, distill durable → path-scoped rules) is the separate
  `audit-memory` skill (built) — not this skill's job.
- **CI memory-hygiene reminder** (prompt retiring a spent `temp/` note when its issue's PR lands) — not yet built.

Don't improvise them here. If you need one, design it deliberately and write the design down first —
these are the pieces most likely to be built badly under time pressure.
