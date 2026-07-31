---
always_on: true
applies_to: any change touching examples/ or dist/, or diagnosing a difference in generated output
---

# Generated Artifacts Are Never Edited

## Enforcement

**Gated for `examples/`** — `npm run examples:check` regenerates every committed example into a temp
directory and compares content *and* executable bits, excluding nothing. A hand-edit fails it. Runs in CI
and in `prepublishOnly`.

**Gated for `dist/`** — `scripts/clean-dist.ts` deletes it at the start of every build, so an edit survives
exactly until the next `npm run build`.

The gates make an edit *futile*. They do not make it *harmless*: the cost is the time spent editing the
wrong file, plus the generator bug that stays unfixed while a patched artifact looks correct.

## Which trees are generated

| Tree | Produced by | Never edit because |
|---|---|---|
| `examples/**` | `npm run examples:refresh` | overwritten on next refresh; `examples:check` fails meanwhile |
| `dist/**` | `npm run build` | deleted at the start of every build |

Everything else is source. When in doubt: if a script can recreate it from `modules/`, it is an artifact.

## The escalation ladder

When a generated file is wrong, work **up** the chain. Never sideways into the artifact.

1. **Regenerate.** `npm run examples:refresh`. If the file is now correct, it was stale — commit the
   refreshed tree as part of the change that caused it.
2. **If it is still wrong, the generator is wrong.** Find the module that produces the file — its `source/`
   tree, its `packageSource/` tree, or the `.hbs` template beside its descriptor — and fix it there.
3. **If the module looks right, the contract or the answers are wrong.** A file can be correct in isolation
   and wrong in context: the wrong template data, a flag no module contributes, a path derived under the
   wrong layout.

Step 3 is not hypothetical. Generated monorepos shipped a `CLAUDE.md` naming paths that did not exist — the
template was internally consistent and the *vocabulary it interpolated* was missing. Patching
`examples/monorepo/CLAUDE.md` would have made the diff green and left every real generated project wrong.

## Drift is information, not noise

When `examples:check` reports drift, **read the diff before refreshing.** It is the only place the effect of
a module change on real output is visible, and that is the entire reason the examples are committed.

Every time drift has been inspected in this repo it has been one of exactly two things:

- **An intended change** — a reworded comment, an added explanation. Refresh and commit.
- **A bug the module change introduced** — caught here rather than by a consumer.

Refreshing without looking discards that signal and converts the second case into a silent regression.
`examples:refresh` is a *response* to having understood the drift, not a way to make it go away.

## Corollaries

- **Never `npm install` inside `examples/`.** The generated `prepare` script runs
  `git config core.hooksPath .githooks`, and git writes repository-level config regardless of which
  subdirectory you are standing in — so it repoints *the factory's own* hooks path and disables its
  pre-commit gate. See `examples/README.md`; this has actually happened.
- **A deleted example directory is not self-cleaning.** `examples:check` iterates `EXAMPLE_PROJECTS`, so an
  orphaned tree once passed as `ok` while describing answers the generator no longer accepted. There is now
  an explicit orphan check; do not remove it.
- **Reading an artifact is encouraged.** The prohibition is on editing. Diffing two examples is often the
  fastest way to understand what an axis actually changes.

## This rule is a hypothesis

What would tell us it is wrong:

- **If a legitimate need to hand-maintain part of an artifact appears**, the tree is misclassified — it is
  source with a generated portion, and the generated portion should be narrowed rather than the rule
  relaxed.
- **If the gates stop catching edits** — someone commits a patched example and CI stays green — the gate has
  a hole and that is the finding, not the rule.

## Scope

The factory's own repository. The equivalent convention for generated projects already ships in their
`CLAUDE.md` and `README.md`, which tell adopters that `COVERAGE.md` is generated and where their `docs/`
come from.
