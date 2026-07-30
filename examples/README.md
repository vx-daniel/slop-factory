# Examples

Real generated projects — one per package manager — committed so the factory's output can be read
without running it.

**These are generated artifacts, not hand-maintained code.** Do not edit them directly — edit the module
that produces the file, then run `npm run examples:refresh` from the repository root.

```bash
npm run examples:refresh   # rewrite these trees from the current modules
npm run examples:check     # fail if they no longer match what the generator produces
```

`examples:check` runs in CI and in `prepublishOnly`. That is the point of committing them: **a stale
example is a confident, wrong answer, which is worse than no example.**

## ⚠️ Do not run `npm install` inside an example

Every generated project contains this script:

```json
"prepare": "git config core.hooksPath .githooks || true"
```

`git config` writes **repository-level** config regardless of which subdirectory you run it from — and
these directories are inside the factory's own repository, not separate repos. So installing here
repoints *the factory's* `core.hooksPath` at `.githooks`, silently disabling the factory's own
pre-commit gate. Verified:

```console
$ git config core.hooksPath          # factory root, before
.githooks-outer
$ cd examples/npm && npm install     # fires the generated prepare script
$ cd ../.. && git config core.hooksPath
.githooks                            # hijacked
```

If you have already done it, `git config --unset core.hooksPath` (or set it back to whatever the factory
uses) puts it right.

**There is no reason to install here.** `tests/generation.test.ts` already installs and gates all eight
combinations in throwaway temp directories, which is safer and more complete than anything these trees
could prove. These exist to be *read* and *diffed*, not executed.

## What is committed, and why only these three

| Directory | Answers | Why this one |
|---|---|---|
| [`npm/`](npm/) | manager `npm`, runner `vitest`, features `config` | The default path. npm implies Node and therefore Vitest — the runner prompt is skipped — so this is the only shape an npm answer can produce. |
| [`pnpm/`](pnpm/) | manager `pnpm`, runner `vitest`, features `config` | Differs from `npm/` in only eight files, and is committed *because* those are the eight people get wrong: the lockfile rule, and the CI step **order** pnpm requires. |
| [`bun/`](bun/) | manager `bun`, runner `bun-test`, features `config` | Bun with its own runner. Chosen over bun + Vitest because that combination differs from `npm/` in only a handful of files, while this one is a genuinely different tree. |

The generator offers **eight** combinations (three managers × config on/off, plus the second runner
choice that only the bun manager can reach). Five are not committed, deliberately: every combination is
already generated, installed, and gated by `tests/generation.test.ts`, so committing all eight would add
review surface without adding verification.

### Why `pnpm/` earns its place and `bun` + Vitest does not

Both are near-duplicates of a committed example, so the tie-breaker is whether the delta contains a
mistake worth showing. `pnpm/`'s does:

```yaml
- uses: pnpm/action-setup@v4      # MUST precede setup-node
- uses: actions/setup-node@v4
  with:
    cache: pnpm                   # resolves the store by running pnpm
```

Reversing those two steps fails, and reports a **cache** error rather than a missing binary — so it sends
you looking in the wrong place. A committed example makes the order readable instead of tribal.

### What `bun` + Vitest would look like

Not committed, so here is the delta rather than leaving it to be guessed. Starting from `npm/`, a
bun + Vitest project differs in only:

- `package.json` — `engines.bun` instead of `engines.node`, no `tsx`, and `bun` as the script runner
  prefix (`bun scripts/gate.ts` rather than `node --import tsx scripts/gate.ts`)
- `.gitignore` — commits `bun.lock`, ignores `package-lock.json` (inverted from `npm/`)
- `.github/workflows/ci.yml` — `oven-sh/setup-bun` and `bun install --frozen-lockfile`
- `.github/workflows/coverage-main.yml` — **absent**. No longer because the workflow is npm-specific — its
  install steps are interpolated now — but because it is unverified under Bun, see
  [#3](https://github.com/vx-daniel/slop-factory/issues/3)
- `docs/bun-runtime.md` replaces `docs/node-runtime.md` and `docs/npm.md`

Everything else — `vitest.config.ts`, the four-metric floor, the `COVERAGE.md` pipeline, `src/config/` —
is identical to `npm/`.

### The `config` feature is on in all three

Every example enables the layered-TOML feature, because without it a generated project contains **no
source code and no tests at all** — `src/` does not exist. That variant is worth *verifying* (both
runners treat zero tests as a failure by default, which is why `passWithNoTests` and the bun-test
floor-guard test exist) but it is not worth *reading*.

## A note on the `name` field

`package.json` in each example reads `"name": "npm"` / `"pnpm"` / `"bun"`, which is not a name anyone
would choose. The example's directory name and the generated project name are deliberately the same
string:
generating under a nicer name and renaming afterwards would force `examples:check` to reproduce the
rename, and any mismatch there would surface as phantom drift. Determinism beat cosmetics in a
`private: true` package that is never published.

## What the diff is for

The reason these are committed rather than generated on demand: edit
`modules/gate/source/biome.json` and the pull request shows one changed line, with no indication of what
actually lands in a generated project. With these committed, the same pull request shows the effect on
real output — and `examples:check` fails if you forget to refresh them.
