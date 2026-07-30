# Examples

Real generated projects, committed so the factory's output can be read without running it.

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
$ cd examples/node && npm install    # fires the generated prepare script
$ cd ../.. && git config core.hooksPath
.githooks                            # hijacked
```

If you have already done it, `git config --unset core.hooksPath` (or set it back to whatever the factory
uses) puts it right.

**There is no reason to install here.** `tests/generation.test.ts` already installs and gates all six
combinations in throwaway temp directories, which is safer and more complete than anything these trees
could prove. These exist to be *read* and *diffed*, not executed.

## What is committed, and why only these two

| Directory | Answers | Why this one |
|---|---|---|
| [`node/`](node/) | runtime `node`, runner `vitest`, features `config` | The default path. Node implies Vitest — the runner prompt is skipped — so this is the only shape a Node answer can produce. |
| [`bun/`](bun/) | runtime `bun`, runner `bun-test`, features `config` | Bun with its own runner. Chosen over bun + Vitest because that combination differs from the Node example in only a handful of files, while this one is a genuinely different tree. |

The generator offers **six** combinations (two runtimes × two runners, minus the two Node+bun-test
combinations that cannot be reached, × config on/off). Four are not committed, deliberately: every
combination is already generated, installed, and gated by `tests/generation.test.ts`, so committing all
six would add review surface without adding verification.

### What `bun` + Vitest would look like

Not committed, so here is the delta rather than leaving it to be guessed. Starting from `node/`, a
bun + Vitest project differs in only:

- `package.json` — `engines.bun` instead of `engines.node`, no `tsx`, and `bun` as the script runner
  prefix (`bun scripts/gate.ts` rather than `node --import tsx scripts/gate.ts`)
- `.gitignore` — commits `bun.lock`, ignores `package-lock.json` (inverted from `node/`)
- `.github/workflows/ci.yml` — `oven-sh/setup-bun` and `bun install --frozen-lockfile`
- `.github/workflows/coverage-main.yml` — **absent**; it is npm-specific, see
  [#3](https://github.com/vx-daniel/slop-factory/issues/3)
- `docs/bun-runtime.md` replaces `docs/node-runtime.md`

Everything else — `vitest.config.ts`, the four-metric floor, the `COVERAGE.md` pipeline, `src/config/` —
is identical to `node/`.

### The `config` feature is on in both

Both examples enable the layered-TOML feature, because without it a generated project contains **no
source code and no tests at all** — `src/` does not exist. That variant is worth *verifying* (both
runners treat zero tests as a failure by default, which is why `passWithNoTests` and the bun-test
floor-guard test exist) but it is not worth *reading*.

## A note on the `name` field

`package.json` in each example reads `"name": "node"` / `"name": "bun"`, which is not a name anyone would
choose. The example's directory name and the generated project name are deliberately the same string:
generating under a nicer name and renaming afterwards would force `examples:check` to reproduce the
rename, and any mismatch there would surface as phantom drift. Determinism beat cosmetics in a
`private: true` package that is never published.

## What the diff is for

The reason these are committed rather than generated on demand: edit
`modules/gate/source/biome.json` and the pull request shows one changed line, with no indication of what
actually lands in a generated project. With these committed, the same pull request shows the effect on
real output — and `examples:check` fails if you forget to refresh them.
