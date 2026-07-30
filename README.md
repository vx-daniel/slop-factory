# slop-factory

![no-slop](assets/slop-factory.png)

A Plop-driven factory that assembles new TypeScript projects from composable modules. It answers a
few prompts, copies the selected modules' file trees, merges their package.json contributions, and
renders the project's documentation.

Every combination it offers is generated, installed, and gated in CI — see
[Verification](#verification). Nothing here is claimed to work without that receipt.

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
([`npm`](examples/npm), [`pnpm`](examples/pnpm), [`bun`](examples/bun)) plus
[`monorepo`](examples/monorepo) for the workspace layout, which is the only axis that changes the shape of
the tree rather than the contents of a few files. Diff `monorepo/` against `npm/` and every difference is
the layout. They are
**generated artifacts**: edit the module that produces a file, then `npm run examples:refresh`.
`examples:check` fails CI if they drift, because a stale example is a confident wrong answer. See
[examples/README.md](examples/README.md) — including why you must not `npm install` inside one.

### Working on the factory itself

```bash
npm install
npm run generate          # builds, then runs the same CLI npx would run
npm run check:all         # the gate: oxlint → tsc → unit tests, cheap-first
npm run lint              # oxlint on its own (lint:fix to autofix)
npm run typecheck         # typechecks the factory
npm test                  # fast unit tests: merge/render logic, registry invariants, source-tree guards
npm run test:prompts      # reads the generator's prompt list and checks it against the contract
npm run test:packaging    # builds + inspects the tarball npm publish would upload
npm run examples:check    # fails if examples/ no longer matches the generator
npm run examples:refresh  # rewrite examples/ from the current modules
npm run verify            # slow: builds, then generates + installs + gates all 6 combinations
KEEP_GENERATED_TREES=1 npm run verify   # same, but leaves the trees on disk to inspect
```

`.github/workflows/ci.yml` runs all of the above on every push and pull request.

**The factory lints itself with oxlint, not the Biome it prescribes for generated projects.** That is a
deliberate divergence with real gaps — most importantly the abbreviation/naming gate has no oxlint
counterpart, and oxlint has no formatter. [docs/lint-parity.md](docs/lint-parity.md) is the rule-for-rule
accounting; read it before treating a green `npm run lint` as equivalent to a green Biome gate.

**The factory always runs its built output, never its TypeScript source** — including in development.
That is not a preference; two independent constraints force it, and both were measured:

1. **Node refuses to strip types under `node_modules`.** It throws
   `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` by design, so that packages ship JavaScript instead of
   making every consumer pay a transform cost. An `npx` install lands in `node_modules`, so publishing
   `.ts` cannot work at any consumer Node version.
2. **node-plop imports the plopfile through Node's own loader.** It does a bare dynamic `import()` of an
   absolute path, bypassing tsx and Vitest's transform whatever is running above it. Node will not remap
   the `./x.js` specifiers inside to their `.ts` siblings, and those specifiers must stay `.js` because
   `allowImportingTsExtensions` requires `noEmit`.

Running the build everywhere turns that constraint into an advantage: `npm run generate` and the test
suites exercise byte-for-byte what `npx slop-factory` runs, rather than a second path that resembles it.

Four Vitest projects, split by cost and by what they can see:

| Project | Cost | Catches |
|---|---|---|
| `unit` | ms | package.json merge conflicts, registry invariants, ignore-file landmines |
| `prompts` | ~1s | a prompt that no longer produces an answer a module selects on |
| `packaging` | ~5s | a file missing from the published tarball |
| `generation` | ~25s | a project that installs but does not pass its own gate |

`prompts` exists because of a real silent failure: the runtime prompt was deleted during a refactor and
**all 87 generation assertions still passed** — that suite supplies answers directly to `runActions`, so
it never sees the prompt list. The generated project had no `engines`, no tsx, and a `check:all` that
died on `Cannot find package 'tsx'`. A module is selected by matching an *answer*, so a prompt that stops
producing that answer disables the module silently, and only reading the prompt list catches it.
`plopfile.ts` now also *throws* on an unknown or missing runtime rather than casting it.

## The channels

A module contributes through five channels — three that place files, two that merge data. The copy/render
split is load-bearing, not stylistic.

| Channel | What it is | Rendered? |
|---|---|---|
| `modules/<name>/source/` | Files copied byte-for-byte to the **project** root | **Never** |
| `modules/<name>/packageSource/` | Files copied byte-for-byte to the **package** root | **Never** |
| `renderedTemplates()` | The `.hbs` files whose content depends on the answers | Yes |
| `packageJsonFragment()` | Scripts, dependencies, engines merged into package.json | n/a |
| `templateData()` | Flags and vocabulary every rendered template sees | n/a |

**Two copy trees, because a module's files do not all belong at the same level.** The config module is
the case that forced it: `config.defaults.toml` belongs at the repository root under any layout (its
loader walks *up* to find it), while `src/config/**` is the package's own source. Under the single-package
layout the two roots are the same directory, so the split is a provable no-op there — which is how it was
introduced without changing a byte of existing output.

**Which module owns a rendered file stays with the module that understands it.** The workspace layout
varies `tsconfig.json`, `vitest.config.ts` and `bunfig.toml`, but does not reach into them: each branches
on the `isMonorepo` flag the `monorepo` module publishes through `templateData()`. That is why no
post-copy transform channel was needed — and a transform channel could have corrupted any file in the
tree, where this cannot.

**Why the copy trees are never rendered.** Handlebars and GitHub Actions both claim `{{ }}`.
`modules/base/source/.github/workflows/claude-pr-review.yml` is full of `${{ }}` expressions; run that
through Handlebars and each one resolves against the answers object, finds nothing, and emits an empty
string — leaving a bare `$` and a silently broken workflow. It installs fine, it typechecks fine, and it
fails only in CI. So the copy channels do no template evaluation whatsoever.

Anything that genuinely needs interpolation lives **outside** any copy tree as a `.hbs` file next to a
module descriptor, so a file cannot be rendered by accident. Each was moved out only after confirming it
contains no `{{ }}` of its own.

Two of those templates are worth singling out:

- **`ci.yml.hbs`** is the one rendered file that legitimately *contains* `${{ }}`, escaped as
  `$\{{ github.ref }}`. It earns the exception because the alternative was one near-identical 50-line
  copy per package manager. A generation test asserts the expression survives intact.
- **`vitest.config.ts.hbs`** is the only `.ts` file rendered, which cuts against the rule above. The
  narrower distinction is who edits it after generation: `src/config/*.ts` is code the adopter extends,
  where a future `{{` is a matter of when, not if; `vitest.config.ts` is generator-owned configuration.
  Its content also varies in a way no data flag can express — under a workspace, `test.include` must be
  *absent* rather than different.

**`ci.yml` is the one exception, and it earns it.** It contains `${{ }}`, so it was originally one
verbatim copy per manager — but a third manager would have meant a third near-identical 50-line file, so
it is now a single `base/ci.yml.hbs` that interpolates the two things that actually vary: the setup steps
and the install command. The GitHub expressions survive because the template escapes them as
`$\{{ github.ref }}`, and `tests/generation.test.ts` asserts the generated file still contains
`${{ github.ref }}` intact — so breaking the escape fails the suite rather than shipping a workflow with a
bare `$` in it.

The general rule still holds: prefer the copy channel, and reach for an escaped template only when the
duplication it replaces is worse than the escaping it introduces.

**`source/` mirrors its own output layout.** `gate/source/scripts/gate.ts` lands at `scripts/gate.ts`.
That convention is the entire mapping — to know where a file ends up, read its path under `source/`.

## Every module documents itself

Each module declares a `documentation` entry and ships the file under its own `source/docs/`, so the
generated project gets a `docs/` folder containing exactly one document per module it was built from,
plus a rendered `docs/README.md` index.

The documents carry the **why** — why Biome is pinned exactly, why `*.io.ts` is exempt from coverage,
why tsx is load-bearing — which is the part that cannot be recovered by reading the config. Because the
copy channel is per-module, an unselected module's document is simply absent rather than describing a
feature the project does not have. `registry.test.ts` asserts every module declares a document, that the
paths are unique, and that the declared file actually exists.

## The modules

Ten modules on four axes: two always-on, one of three package managers (plus the runtime it implies), one
of two test runners, one of two layouts, plus opt-in features.

| Module | Selected when | Owns |
|---|---|---|
| `base` | always | tsconfig, `.claude/` rules + skills, pre-commit hook, the org workflow stubs, `@types/node`, the rendered `ci.yml` |
| `gate` | always | Biome, the naming plugin, TypeScript, `scripts/gate.ts`, the check scripts |
| `node` | manager is npm or pnpm | Node 24 engine floor, tsx |
| `npm` | manager = npm | `npm ci`, `package-lock.json`, `npx` |
| `pnpm` | manager = pnpm | `pnpm install --frozen-lockfile`, `pnpm-lock.yaml`, `pnpm exec`, the extra CI setup step |
| `bun` | manager = bun | Bun engine floor, and the Bun manager vocabulary — for Bun the two are one choice |
| `vitest` | runner = vitest | `vitest.config.ts`, the 4-metric floor, the `COVERAGE.md` pipeline, `coverage-main.yml` |
| `bun-test` | runner = bun-test | `bunfig.toml`, the `vitest` type shim, the floor-guard test |
| `monorepo` | layout = monorepo | The per-package `package.json`, and the `isMonorepo` vocabulary other modules' templates branch on |
| `config` | `config` feature | Layered TOML config, Zod schema, `src/config/`, `.env.example` |

`npm`/`pnpm`/`bun` are mutually exclusive, and so are `vitest`/`bun-test` — enforced by their
`isSelected` predicates, each keyed off a single answer. `registry.test.ts` asserts exactly one manager
and exactly one runner is ever selected, because two managers would conflict on `engines` and two runners
on the `test` script.

`node` is the one module that is **not** part of a mutually exclusive set: it is selected alongside
whichever of `npm`/`pnpm` was chosen, because both mean the Node runtime and both need exactly the same
two things — the engine floor and tsx. Giving each manager its own copy would duplicate them, and a third
Node manager would duplicate them again.

Five placements are deliberate and look wrong at first glance:

- **The test runner is not a runtime concern.** Bun ships its own runner, so it looks like one — but the
  choice is genuinely orthogonal: you can run on Bun and keep Vitest, which is the default. That is why
  `vitest`/`bun-test` are their own axis rather than folded into `bun`.
- **`bun` is the thinnest module, and that thinness is the finding.** Bun runs `.ts` and resolves
  tsconfig `paths` natively, so the whole tsx layer drops out — there is nothing to install in its place.
- **`@types/node` is in `base`, not `node`.** The shipped tsconfig sets `"types": ["node"]`, so omitting
  it fails `tsc --noEmit` under either runtime.
- **`ci.yml` is in `base`, not the manager modules,** even though installing dependencies is the most
  manager-specific thing a workflow does. It used to be one verbatim copy per manager; the parts that
  actually vary are the setup steps and the install command, so it is now a single rendered template that
  interpolates vocabulary the manager modules contribute. Three near-identical 50-line copies was the
  alternative. This makes `ci.yml` the one workflow where the Handlebars / GitHub Actions `{{ }}`
  collision is live, which is why the template escapes `${{ github.ref }}` and a test asserts it survives.
- **`coverage-main.yml` is in `vitest`, and its Node-only gate lives in `renderedTemplates()`** rather
  than in a template flag. The file is Vitest-specific — it reads the `json-summary` reporter's output,
  which `bun test` does not produce — but whether it ships is a question about the file *existing*, and
  template data can only make contents conditional, never decline to create a file. It ships for the Node
  managers only; that is an unverified-under-Bun limitation, not a necessity
  ([#3](https://github.com/vx-daniel/slop-factory/issues/3)), so a `bun + vitest` project runs
  `coverage:readme` locally instead.

### The `bun test` trade, and why it is offered anyway

`bun test` works: Bun maps the `vitest` import onto its own API, so test files run unmodified with
Vitest not installed. What it costs, all handled explicitly by the `bun-test` module rather than left to
surprise the operator:

| Loss | How the module handles it |
|---|---|
| Coverage drops to `% Funcs` + `% Lines`, **and untested files are invisible** — Bun has no `coverage.include`, so an orphan module is absent from the table while the total reads 100% | Floor moves to `bunfig.toml`; both losses are documented at the setting and in the generated doc |
| No `json-summary` reporter, so no `COVERAGE.md` | `coverage:readme` and `coverage:open` are simply not shipped |
| No `passWithNoTests` — zero tests is a hard exit 1 | Ships one **real** test that guards the coverage threshold, since nothing else reads `bunfig.toml` |
| `tsc` cannot follow Bun's `vitest` mapping | Ships `test/vitest-shim.d.ts` + `@types/bun`, and tsconfig renders `types: ["node","bun"]` |

That last one was found by the generation suite, not by reading: the tests passed and the **typecheck**
gate failed, which is the worst kind of split.

## Adding a module

1. `mkdir modules/<name>` and put files under `modules/<name>/source/`, laid out exactly as they should
   appear in the generated project.
2. Write its document at `modules/<name>/source/docs/<something>.md`. This is required, not optional —
   `registry.test.ts` fails a module that declares no document or declares one that does not exist.
3. Write `modules/<name>/module.ts` exporting a `ProjectModule` — a name, a `documentation` entry, an
   `isSelected` predicate, and a `packageJsonFragment`.
4. Register it in `modules/registry.ts`.
5. If it is opt-in, add its value to the `enableFeatures` checkbox in `plopfile.ts`.
6. Add the combination to `COMBINATIONS` in `tests/generation.test.ts`, then run `npm test` and
   `npm run verify`.

A module with no `source/` tree is legitimate: `npm` and `pnpm` have one only because every module must
document itself. Otherwise they would contribute nothing but template data — the install command, the
committed lockfile, the `setup-node` cache key — which is exactly what a manager module is for.

**package.json conflicts throw, they do not last-write-wins.** Two modules claiming the same script
name, or pinning one dependency to different versions, is a factory bug: silently picking one would
ship a project whose gate runs something its author did not choose, and the symptom would surface far
from the cause. The error names both modules and the key. Contributing an *identical* value twice is
fine — two modules may legitimately need the same pin.

## Verification

`npm run verify` generates each combination into a temp directory, git-inits it, installs it, and runs
the generated project's own gate and coverage — then asserts a set of things only a real tree can show.

The expensive version is the one that ships because the failures that matter most are invisible to
anything cheaper. All of these install and typecheck cleanly, or typecheck and then fail elsewhere:

- a fragment merge producing a project whose dependencies do not satisfy its own scripts;
- a file rendered when it should have been copied verbatim (the `${{ }}` collision);
- the pre-commit hook copied without its executable bit — git then declines to run it, silently;
- `.gitignore`'s order-sensitive `config.*.toml` / `!config.defaults.toml` pair being reordered;
- `coverage:readme` not finding the marker block in the rendered README;
- a test file that runs but does not typecheck;
- a workflow shipped to a runtime whose package manager it does not use.

The suite git-inits each tree because three of those do not exist without one — `prepare` prints
"fatal: not in a git directory" and passes anyway, so an un-inited tree silently skips the hook wiring
it is supposed to verify.

Current status — 6 combinations, 75 assertions, all pass (9 skipped as runner- or feature-specific):

| Runtime | Runner | Features | Gate | Coverage |
|---|---|---|---|---|
| node | vitest | config | ✅ | ✅ |
| node | vitest | none | ✅ | ✅ |
| bun | vitest | config | ✅ | ✅ |
| bun | vitest | none | ✅ | ✅ |
| bun | bun-test | config | ✅ | ✅ |
| bun | bun-test | none | ✅ | ✅ |

The "no features" rows matter more than they look: with no config module the project has no source code
and no tests, which **both** runners treat as a failure by default. Vitest gets `passWithNoTests` (safe
because the coverage floor still catches a silently-empty suite, and CI runs both); `bun test` has no
such flag, which is why the `bun-test` module ships a real test of its own.

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

## Publishing

> **Not publish-ready yet** — see [#4](https://github.com/vx-daniel/slop-factory/issues/4) for the
> metadata that has to land first.

The published package is **only** `bin/`, `dist/`, and this README — `files` is an allowlist, so
anything not named is absent from the tarball.

```bash
npm publish        # prepublishOnly runs: check:all → test:prompts → test:packaging → verify
```

`npm run build` does two things, and the split matters:

1. `tsc -p tsconfig.build.json` compiles the factory's own code into `dist/`, mirroring the repo layout
   (`plopfile.ts` → `dist/plopfile.js`, `modules/base/module.ts` → `dist/modules/base/module.js`).
2. `scripts/copy-dist-assets.ts` copies each module's `source/` tree and `.hbs` templates into
   `dist/modules/<name>/`.

Step 2 exists because a module's `source/` tree is **payload, not code** — copied byte-for-byte into
generated projects, and several of those files are `.ts` that must *remain* `.ts` because they are the
generated project's own source. Compiling them would be exactly wrong. Mirroring the layout inside
`dist/` is what lets the plopfile resolve `modules/<name>/source` relative to its own directory
unchanged, with no "am I built?" branch anywhere in the generator.

**`tests/packaging.test.ts` guards the tarball**, because every other test runs against the working
tree where every file is present by definition. A `files` entry omitted, or an ignore rule swallowing a
template, produces a package that installs cleanly and fails at the consumer's first `generate`. It
asserts the CLI entry points, every module's compiled descriptor and document, the dot-path assets, all
five rendered templates, and that no uncompiled source or test file leaked in.

One packaging trap is guarded separately in `modules/module-sources.test.ts`: **npm honours
`.gitignore` / `.npmignore` files anywhere inside a package as pack filters.** A
`modules/base/source/.codegraph/.gitignore` containing `*` used to exist, and `npm pack --dry-run`
confirmed it excluded a sibling file from the tarball. It was harmless there and has been deleted (the
generated root `.gitignore` already ignores `.codegraph/` entirely), but the same pattern one directory
higher would ship a silently broken package. A generated project's `.gitignore` comes from a rendered
template outside any `source/` tree, which is where such a file belongs.

## Requirements

Node **24+** for the CLI. Bun **1.3+** is needed only to verify the Bun combinations; the generation
suite skips them if Bun is absent.
