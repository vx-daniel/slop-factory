# slop-factory

![no-slop](assets/slop-factory.png)

A Plop-driven factory that assembles new TypeScript projects from composable modules. It answers a
few prompts, copies the selected modules' file trees, merges their package.json contributions, and
renders the project's documentation.

Every layout, package manager, and test runner it offers is generated, installed, and gated in CI — see
[docs/verification.md](docs/verification.md). Nothing here is claimed to work without that receipt.

## Usage

```bash
npx slop-factory generate
```

That is the whole thing — no clone, no install. Prompts, in order: project name (also the directory
name), destination directory (**defaults to `.`**, must already exist), layout (**single** or
**monorepo**), **first package name (asked only for a monorepo**, defaults to `core`), package manager
(**npm**, **pnpm** or **bun** — which also decides the runtime), **test runner (asked only for bun)**, and
optional features. Nothing is written until every question is answered, and it refuses to generate into a
non-empty directory — so accepting every default puts the project in a new subdirectory of wherever you
ran it.

```bash
npx slop-factory --help
npx slop-factory --version
```

### What the output looks like

[`examples/`](examples/) holds four real generated projects — one per package manager
([`node-npm`](examples/node-npm), [`node-pnpm`](examples/node-pnpm), [`bun`](examples/bun)) plus
[`node-npm-monorepo`](examples/node-npm-monorepo) for the workspace layout, which is the only axis that
changes the shape of the tree rather than the contents of a few files. Each name states its runtime and
manager — `bun` needs no suffix because for Bun those are one choice. Diff `node-npm-monorepo/` against
`node-npm/` and every difference is the layout. They are
**generated artifacts**: edit the module that produces a file, then `npm run examples:refresh`.
`examples:check` fails CI if they drift, because a stale example is a confident wrong answer. See
[examples/README.md](examples/README.md) — including why you must not `npm install` inside one.

### Working on the factory itself

```bash
npm install
npm run generate          # builds, then runs the same CLI npx would run
npm run check:all         # the gate: biome → tsc → unit tests, cheap-first
npm run lint              # biome check on its own (lint:fix to autofix, format to reformat)
npm run typecheck         # typechecks the factory
npm test                  # fast unit tests: merge/render logic, registry invariants, source-tree guards
npm run test:prompts      # reads the generator's prompt list and checks it against the contract
npm run test:layout       # generates into a temp dir and checks WHERE files land — installs nothing
npm run test:packaging    # builds + inspects the tarball npm publish would upload
npm run examples:check    # fails if examples/ no longer matches the generator
npm run examples:refresh  # rewrite examples/ from the current modules
npm run verify            # slow: generates + installs + gates 10 of the 16 combinations, printing the rest
KEEP_GENERATED_TREES=1 npm run verify   # same, but leaves the trees on disk to inspect
```

`.github/workflows/ci.yml` runs all of the above on every push and pull request.

**Start at [CLAUDE.md](CLAUDE.md) if you are an agent**, and at
[docs/module-contract.md](docs/module-contract.md) if you are about to touch a module.

**Conventions for working on the factory live in [`.claude/rules/`](.claude/rules/).** These are distinct
from the rules the factory *ships* (`modules/base/source/.claude/rules/`, which land in generated
projects): they govern this repository's own code. Each states the failure mode it exists to block, so a
future reader can tell when that failure mode has shifted and the rule should change.

There are two of everything for that reason — the factory's own `CLAUDE.md`, rules, linter and docs, and a
separate set that ships. Editing the wrong side is the most expensive mistake available here, so
[CLAUDE.md](CLAUDE.md) opens with the mapping.

**The factory lints itself with the Biome config it ships.** `biome.jsonc` at the root *extends*
`modules/gate/source/biome.json` rather than restating it, so there is one copy of the rules and the factory
is held to exactly the standard it prescribes — including the GritQL naming gate, which under the previous
oxlint setup had no counterpart at all and so never applied to its own author.

It also runs its own pre-commit hook, wired by `prepare` the same way generated projects do, plus the two
workflows it ships — `claude-pr-review.yml` and `secret-scan.yml` — as byte-identical copies guarded against
drift by `modules/payload-copies.test.ts`.

All of that was absent until recently: the factory prescribed a gate it did not run, a linter it did not use,
a reviewer it did not submit to, and a secret scanner it did not run on itself. The payoff of closing the gap
is that a broken shipped workflow now fails on **the factory's own** pull requests rather than on an adopter's
first one.


## Documentation

The README is the front door; the reasoning lives in [`docs/`](docs/), one document per concern.

| Document | What it covers |
|---|---|
| [module-contract.md](docs/module-contract.md) | The five channels, why copy trees are never rendered, and how to add a module |
| [modules.md](docs/modules.md) | What each of the ten modules owns, which sets are exclusive, and the `bun test` trade |
| [verification.md](docs/verification.md) | The six suites, why the derived matrix is sampled, and how to read a green run |
| [publishing.md](docs/publishing.md) | The three-step build, and what guards the published tarball |

Generated projects get their own `docs/` folder — one document per module they were built from. See
[Every module documents itself](docs/module-contract.md#every-module-documents-itself).

## Known limitations

Each is tracked as an issue rather than restated here, so there is one place to read the current state
and one place to change it. The summaries below are pointers, not the record.

| # | Limitation | Effect |
|---|---|---|
| [#1](https://github.com/vx-daniel/slop-factory/issues/1) | A workspace starts with exactly one package | The prompt asks for one package name; adding a second is three manual steps, documented in the generated `docs/monorepo.md`. Generating several would mean guessing what they are. |
| [#2](https://github.com/vx-daniel/slop-factory/issues/2) | `generate` has no non-interactive mode | Requires a TTY; cannot run in CI or from a script |
| [#3](https://github.com/vx-daniel/slop-factory/issues/3) | `bun + vitest` gets no `coverage-main.yml` | `COVERAGE.md` must be refreshed locally with `coverage:readme` |
| [#4](https://github.com/vx-daniel/slop-factory/issues/4) | Package metadata is not publish-ready | No `repository` field — npm needs it for provenance; blocks the first `npm publish` |
| [#5](https://github.com/vx-daniel/slop-factory/issues/5) | `bun test` coverage is blind to untested files | An untested `src/` file is absent from the report while the total reads 100% |
| [#7](https://github.com/vx-daniel/slop-factory/issues/7) | Deprecated `actions/checkout@v4` / `setup-node@v4` pins | Generated projects emit a Node 20 deprecation annotation on their first CI run |
| [#10](https://github.com/vx-daniel/slop-factory/issues/10) | yarn is not offered | npm, pnpm and bun are. The generated gate's `detectPackageManager()` recognises yarn, so a project can be migrated by hand, but the generator neither produces nor verifies that combination. |

One of these is worth understanding before choosing options at the prompt:

**Choosing `bun test` weakens the coverage floor more than the metric count suggests**
([#5](https://github.com/vx-daniel/slop-factory/issues/5)). Measured on Bun 1.3.14: an untested
`src/orphan.ts` containing a branch was absent from the coverage table entirely, the total still read
`100.00`, and the floor passed. Bun has no equivalent of Vitest's `coverage.include`. The floor certifies
that covered files are well covered — not that all files are covered.


## Requirements

Node **24+** for the CLI. Bun **1.3+** is needed only to verify the Bun combinations; the generation
suite skips them if Bun is absent.