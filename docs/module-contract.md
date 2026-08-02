# The module contract

How a module contributes to a generated project, and how to write one. The contract itself is
`modules/module-contract.ts`; this explains the reasoning the type signatures cannot carry.

## The channels

Some place files, the rest merge data. The copy/render split is load-bearing, not stylistic.

| Channel | What it is | Rendered? |
|---|---|---|
| `modules/<name>/source/` | Files copied byte-for-byte to the **project** root | **Never** |
| `modules/<name>/packageSource/` | Files copied byte-for-byte to the **package** root | **Never** |
| `renderedTemplates()` | The `.hbs` files whose content depends on the answers | Yes |
| `packageJsonFragment()` | Scripts, dependencies, engines merged into package.json | n/a |
| `templateData()` | Flags and vocabulary every rendered template sees | n/a |

**`source/` mirrors its own output layout.** `gate/source/scripts/gate.ts` lands at `scripts/gate.ts`.
That convention is the entire mapping — to know where a file ends up, read its path under the copy tree,
then read which root that tree lands in.

## Why there is more than one copy tree

A module's files do not all belong at the same level. The config module is the case that forced it:
`config.defaults.toml` belongs at the repository root under any layout (its loader walks *up* to find
it), while `src/config/**` is the package's own source.

Under the single-package layout the roots coincide in the **same directory**, so the split is a provable
no-op there — which is how it was introduced without changing a byte of existing output. Under a
workspace, `packageSource/` lands in `packages/<name>/` and the split starts doing visible work.

## Why the copy trees are never rendered

Handlebars and GitHub Actions both claim `{{ }}`.
`modules/base/source/.github/workflows/claude-pr-review.yml` is full of `${{ }}` expressions; run that
through Handlebars and each one resolves against the answers object, finds nothing, and emits an empty
string — leaving a bare `$` and a silently broken workflow. It installs fine, it typechecks fine, and it
fails only in CI.

So the copy channels do no template evaluation whatsoever. Anything that genuinely needs interpolation
lives **outside** any copy tree as a `.hbs` file next to a module descriptor, so a file cannot be rendered
by accident. Each was moved out only after confirming it contains no `{{ }}` of its own.

### The templates that cut against that rule

**`ci.yml.hbs` legitimately contains `${{ }}`**, escaped as `$\{{ github.ref }}`. It was originally one
verbatim copy per package manager; a third manager would have meant a third near-identical 50-line file,
so it is now one template interpolating what actually varies — the setup steps and the
install command. `tests/generation.test.ts` asserts the generated file still contains
`${{ github.ref }}` intact, so breaking the escape fails the suite rather than shipping a workflow with a
bare `$` in it.

**`vitest.config.ts.hbs` is the only rendered `.ts` file.** The narrower distinction that earns it: who
edits the file after generation. `src/config/*.ts` is code the adopter extends, where a future `{{` is a
matter of when, not if; `vitest.config.ts` is generator-owned configuration where an adopter changes a
threshold, not the syntax. Its content also varies in a way no data flag can express — under a workspace,
`test.include` must be *absent* rather than different.

The general rule still holds: prefer the copy channel, and reach for an escaped template only when the
duplication it replaces is worse than the escaping it introduces.

## Layout variation stays with the owning module

The workspace layout varies `tsconfig.json`, `vitest.config.ts` and `bunfig.toml` — but the `monorepo`
module does not reach into them. Each branches on the `isMonorepo` flag that module publishes through
`templateData()`, so every file stays owned by the module that understands it.

That is why **no post-copy transform channel was needed**, which this module was deferred for a long time
believing it required. A transform channel could have corrupted any file in the tree; this arrangement
cannot.

The `monorepo` module publishes only the facts it alone knows (`isMonorepo`, `packageNames`). Paths
*derived* from those facts — `sourceDirectory`, `importAliasPattern`, `coverageSourceGlob` — come from
`base`, because they have a correct value under **both** layouts and a module absent under `single` cannot
supply one. See `pathVocabulary` in the contract.

## Every module documents itself

Each module declares a `documentation` entry and ships the file under its own `source/docs/`, so the
generated project gets a `docs/` folder containing exactly one document per module it was built from, plus
a rendered `docs/README.md` index.

The documents carry the **why** — why Biome is pinned exactly, why `*.io.ts` is exempt from coverage, why
tsx is load-bearing — which is the part that cannot be recovered by reading the config. Because the copy
channel is per-module, an unselected module's document is simply absent rather than describing a feature
the project does not have.

`registry.test.ts` asserts every module declares a document, that the paths are unique, and that the
declared file actually exists.

## Conflicts throw; they do not last-write-wins

Two modules claiming the same script name, or pinning one dependency to different versions, is a factory
bug. Silently picking one would ship a project whose gate runs something its author did not choose, and
the symptom would surface far from the cause. The error names both modules and the key.

Contributing an *identical* value twice is fine — two modules may legitimately need the same pin. The same
discipline applies to `templateData()`: two modules disagreeing about a flag throws, because the rendered
output would otherwise depend on registry order.

Rendered **output paths** are checked too: `registry.test.ts` asserts no two selected modules write the
same path, across every reachable answer set. A collision would mean one module silently overwriting the
other, with the winner decided by registry order.

## Adding a module

1. `mkdir modules/<name>` and put files under `modules/<name>/source/`, laid out exactly as they should
   appear in the generated project. Use `packageSource/` for anything that belongs beside the package's
   own source rather than at the repository root.
2. Write its document at `modules/<name>/source/docs/<something>.md`. Required, not optional —
   `registry.test.ts` fails a module that declares no document or declares one that does not exist.
3. Write `modules/<name>/module.ts` exporting a `ProjectModule` — a name, a `documentation` entry, an
   `isSelected` predicate, and a `packageJsonFragment`.
4. Register it in `modules/registry.ts`.
5. If it is opt-in, add its value to the `enableFeatures` checkbox in `plopfile.ts`.
6. Run `npm test`, `npm run test:layout`, and `npm run verify`.

**Step 6 used to include "add the combination to `COMBINATIONS`".** It no longer does: the generation
matrix is computed from the contract's own constants, so a new *answer value* extends it automatically. A
new module selected by an existing answer needs no matrix change at all.

A module with **no `source/` tree is legitimate.** `npm` and `pnpm` have one only because every module
must document itself; otherwise they would contribute nothing but template data — the install command, the
committed lockfile, the `setup-node` cache key — which is exactly what a manager module is for.

## Related

- [`verification.md`](verification.md) — what proves a module change is correct
- [`verification.md`](verification.md) — the suites, and why the factory's linter extends the one it ships
- [`.claude/rules/`](../.claude/rules/) — conventions for working on this repository
