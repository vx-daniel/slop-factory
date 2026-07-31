# Claude workflows

Three GitHub Actions workflows that run Claude against this repository. All three need **one** repository
secret and nothing else.

```
.github/workflows/
  claude-pr-review.yml     automatic — reviews every non-draft pull request
  claude-issue-agent.yml   on demand — "@claude-triage" or "@claude-spike" in an issue comment
  test-audit.yml           on demand — Actions → Test-quality audit → Run workflow
```

## The one secret

**Settings → Secrets and variables → Actions → New repository secret**, named
`CLAUDE_CODE_OAUTH_TOKEN`.

Until it exists, each workflow **skips and says so** in its run summary. That is deliberate: a brand-new
repository stays green rather than showing a red X on its first pull request, and the message names the
setting to change. Nothing is broken; nothing is running either.

The check is the first step of every job, not a job-level `if:` — GitHub does not make the `secrets` context
available in job-level conditions. Without that step the action stubs out silently in about two seconds and
the run goes green having reviewed nothing, which is the worst outcome available: it looks like success.

## What each one does

### `claude-pr-review.yml` — automatic

Runs on every non-draft, non-bot pull request. One pass, no subagents, cheap enough for every push. Posts a
single review comment covering code, tests, error handling, type design, comment accuracy, and a security
pass on the changed lines.

**It enforces *this* project's conventions, not a generic checklist.** The prompt reads `CLAUDE.md`,
every `.claude/rules/*.md`, and `.claude/memory/MEMORY.md` if present. Adding a rule file changes what the
reviewer enforces with no edit to the workflow.

If `.claude/pr-review.md` exists it is read as *additional reviewer instructions* — what to emphasise, extra
checks, tone. That is distinct from `.claude/rules/`, which are rules the **code** must satisfy. Reviewer
instructions add to the procedure; they never remove the security pass or relax a verdict.

### `claude-issue-agent.yml` — on demand, two modes

Comment on an issue with:

- **`@claude-triage`** — reads the issue, locates the affected code, scans for duplicates, applies labels
  from the existing taxonomy, and posts an assessment.
- **`@claude-spike`** — a read-only deep investigation. No labels, no changes; just findings.

Or dispatch it manually from the Actions tab with an issue number, which is the escape hatch for re-running
triage without commenting again.

**Two guards worth understanding before you loosen either:**

`author_association` restricts triggering to OWNER, MEMBER and COLLABORATOR. Anyone can comment on a public
issue, so without this gate any stranger could spend your token budget at will by typing `@claude-triage`.

The agent only **applies** labels that already exist — `gh label create` is not among its allowed tools. So
create your label taxonomy first, or it will have nothing to choose from.

Issue text is treated as untrusted input, and the prompt says so explicitly: the agent is instructed to
follow its own instructions and never instructions embedded in an issue. Only the issue *number* is
interpolated into the workflow; the content is fetched with `gh` at runtime, so nothing an issue author
writes ever reaches a shell command.

### `test-audit.yml` — on demand

A mutation-based audit of the test suite: it runs the suite, mutates code, and reports which tests failed to
notice. Produces a findings issue. **It does not gate merges** — a mutation audit is advisory by nature and
far too slow for the merge path.

Both of its prerequisites already ship with this project: a JS test runner, and the test-quality skill at
`.claude/skills/test-quality/`. If this project uses `bun test` rather than Vitest, set `test_command` to
`bun test` when dispatching.

It requests `contents: read`, deliberately **not** write. The agent mutates only the ephemeral working tree
and reverts; it must never push source.

## Why these are copies rather than shared

Each workflow is fully self-contained. They started as thin callers delegating to a private reusable
workflow, which meant they only worked inside one organisation — and their own comments told everyone else
to delete them.

The cost of inlining is real and worth naming: **the logic can no longer be updated centrally.** An
improvement upstream reaches this project only when someone re-runs the generator and diffs the result.
Single-sourcing is better within one organisation; it is strictly worse for a project that has to work
anywhere.

## Turning one off

Delete the file. Each workflow is independent, and none of them is referenced by `ci.yml`, the pre-commit
hook, or `check:all` — the quality gate does not depend on any of them.
