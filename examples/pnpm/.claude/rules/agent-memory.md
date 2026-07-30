---
trigger_phrase:
  haiku: "two index agent memory durable current split"
  opus: "agent memory durable vs current task split synced to repo"
  sonnet: "agent memory two index split durable current"
always_on: true
---

# Agent Memory — Two-Index Split, Synced to the Repo

Agent auto-memory is **machine-local** (`~/.claude/projects/<project>/memory/`) — you read and write
it there during a session, but it never travels to teammates or to the CI PR reviewer. Two skills make
the durable half portable:

- **`sync-project-memory`** (export) mirrors durable memories into the committed `.claude/memory/` so
  they are version-controlled and shareable.
- **`audit-memory`** (distill, **propose-only**) audits the committed corpus and proposes promoting
  recurring themes into `.claude/rules/`. It never auto-writes a rule or deletes a memory.

The audience for everything below is **agents**, not humans — optimize for the next agent's recall and
for context cost.

## Not yet wired in this repo (be honest about the gap)

The **convention** below applies now. The auto-load plumbing does **not** exist here yet:

- `CLAUDE.md` has **no `@import`** of the durable index, so committed memory is *shareable via the
  repo* but not auto-loaded into local sessions until that import is added.
- `.github/workflows/claude-pr-review.yml` does **not** `Read` the memory index, so the CI reviewer
  does not see committed memory yet.
- `.claude/memory/` does not exist until `sync-project-memory` first creates it.

Until those land, treat committed memory as a shared artifact you (or the reviewer) must open
explicitly — not as always-loaded context. Don't write rules or PR text that assume auto-load.

## Two indices — classify at write time

Every memory belongs to exactly one of two indices. Decide which as you write it; misclassifying means
a future agent either loads stale state as if durable, or loses a durable principle in transient noise.

| Index | Holds | Lifespan |
|---|---|---|
| **`MEMORY.md`** | **Durable** knowledge — principles, preferences, conventions, references that stay true across tasks (`feedback`, `user`, `reference`). | Long-lived; outlives any one task. |
| **`MEMORY_CURRENT.md`** | **Current-task / feature** notes tied to in-flight issues or PRs (`project`). | High staleness; retired when the task ships. |

Heuristic: *if it would still be true and useful six months and three features from now, it's durable →
`MEMORY.md`. If it's "where this batch stands" / "what we're assuming for #N", it's current →
`MEMORY_CURRENT.md`.* Current-task memories should cite their issue/PR number.

When unsure, prefer `MEMORY_CURRENT.md`. A durable principle wrongly filed as current is merely
under-shared until the auditor promotes it; transient state wrongly filed as durable is loaded into
every session as if it were a standing rule.

## `MEMORY.md` carries a persistent header

`MEMORY.md` must begin with the header block below, preserved on every rewrite of the index. It tells
the next agent the split exists and points at the current-task index. `sync-project-memory` re-asserts
it on each regeneration, so a clobbered header self-heals on the next sync — but don't rely on that.

```markdown
# Memory Index — Durable

> **Two-index memory** (see `.claude/rules/agent-memory.md`). This file holds **durable** project
> knowledge shared with the whole team via the repo. **Current-task / feature notes live in
> [`MEMORY_CURRENT.md`](./MEMORY_CURRENT.md)** — high-staleness working memory, not durable principle.
> Do not file durable knowledge there, and do not treat current-task notes as standing rules.
```

## What syncs, what stays

- **Durable** (`MEMORY.md` + its files) → mirrored to committed `.claude/memory/` by
  `sync-project-memory`. This is the shareable, version-controlled payload.
- **Current** (`MEMORY_CURRENT.md` + files under `.claude/memory/temp/`) → an audit trail of *why*
  decisions were made and *what* was assumed, targeted at local working agents. Do **not** treat
  anything under `.claude/memory/temp/` as authoritative durable knowledge.
- **GitHub issues/PRs** remain the shared source of truth for task state. The temp memory is the
  agent's working index of that state, not a replacement for it.

A current-task memory is retired when the PR that closes its issue lands; git history under `temp/`
keeps the retired note as the permanent audit trail, so removal from the live tree loses nothing.

## Discipline carried from how these memories were earned

- **Currency over recency-blindness.** A memory is a point-in-time observation. Before treating one as
  fact, check it against current code; watch for supersession language ("superseded", "no longer
  true"). Recalled memories reflect what was true when written — if one names a file, function, or flag,
  verify it still exists before acting on it.
- **Provenance.** Durable memories cite the incident that earned them (issue/PR + date). When a memory
  is promoted to a `.claude/rules/` rule, carry that citation — a rule with no traceable "why" rots
  exactly as an unsourced memory does.
- **Propose, don't auto-act, on promotion.** Distilling memory → an always-on rule is high-blast-radius
  (it loads into every future session). Surface the proposal; a human approves. This is why
  `audit-memory` is propose-only.
