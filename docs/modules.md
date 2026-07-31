# The modules

Ten modules on four axes: two always-on, one of three package managers (plus the runtime it implies), one
of two test runners, one of two layouts, plus opt-in features.

See [`module-contract.md`](module-contract.md) for how a module contributes, and how to add one.

| Module | Selected when | Owns |
|---|---|---|
| `base` | always | tsconfig, `.claude/` rules + skills, pre-commit hook, the org workflow stubs, `@types/node`, the rendered `ci.yml`, the path vocabulary the prose templates interpolate |
| `gate` | always | Biome, the naming plugin, TypeScript, `scripts/gate.ts`, the check scripts |
| `node` | manager is npm or pnpm | Node 24 engine floor, tsx |
| `npm` | manager = npm | `npm ci`, `package-lock.json`, `npx` |
| `pnpm` | manager = pnpm | `pnpm install --frozen-lockfile`, `pnpm-lock.yaml`, `pnpm exec`, the extra CI setup step |
| `bun` | manager = bun | Bun engine floor, and the Bun manager vocabulary — for Bun the two are one choice |
| `vitest` | runner = vitest | `vitest.config.ts`, the 4-metric floor, the `COVERAGE.md` pipeline, `coverage-main.yml` |
| `bun-test` | runner = bun-test | `bunfig.toml`, the `vitest` type shim, the floor-guard test |
| `monorepo` | layout = monorepo | The per-package `package.json`, and the `isMonorepo` vocabulary other modules' templates branch on |
| `config` | `config` feature | Layered TOML config, Zod schema, the `config/` source tree, `.env.example` |

## Which sets are exclusive

`npm`/`pnpm`/`bun` are mutually exclusive, and so are `vitest`/`bun-test` — enforced by their `isSelected`
predicates, each keyed off a single answer. `registry.test.ts` asserts exactly one manager and exactly one
runner is ever selected, because two managers would conflict on `engines` and two runners on the `test`
script.

**`node` is the exception, and it reads like a fourth manager.** It is selected *alongside* whichever of
`npm`/`pnpm` was chosen, keyed off the runtime those managers imply. Both need exactly the same two things
— the engine floor and tsx — so giving each manager its own copy would duplicate them, and a third Node
manager would duplicate them again.

`monorepo` is orthogonal to both sets: a workspace can use any manager and either runner.

## Five placements that look wrong at first glance

**The test runner is not a runtime concern.** Bun ships its own runner, so it looks like one — but the
choice is genuinely orthogonal: you can run on Bun and keep Vitest, which is the default. That is why
`vitest`/`bun-test` are their own axis rather than folded into `bun`.

**`bun` is the thinnest module, and that thinness is the finding.** Bun runs `.ts` and resolves tsconfig
`paths` natively, so the whole tsx layer drops out — there is nothing to install in its place.

**`@types/node` is in `base`, not `node`.** The shipped tsconfig sets `"types": ["node"]`, so omitting it
fails `tsc --noEmit` under either runtime.

**`ci.yml` is in `base`, not the manager modules** — even though installing dependencies is the most
manager-specific thing a workflow does. The parts that actually vary are the setup steps and the install
command, so it is one rendered template interpolating vocabulary the manager modules contribute. Three
near-identical 50-line copies was the alternative.

**`coverage-main.yml` is in `vitest`, and its Node-only gate lives in `renderedTemplates()`** rather than
in a template flag. The file is Vitest-specific — it reads the `json-summary` reporter's output, which
`bun test` does not produce — but whether it ships is a question about the file *existing*, and template
data can only make contents conditional, never decline to create a file. It ships for the Node managers
only; that is an unverified-under-Bun limitation, not a necessity
([#3](https://github.com/vx-daniel/slop-factory/issues/3)), so a `bun + vitest` project runs
`coverage:readme` locally instead.

## The `bun test` trade, and why it is offered anyway

`bun test` works: Bun maps the `vitest` import onto its own API, so test files run unmodified with Vitest
not installed. What it costs, all handled explicitly by the `bun-test` module rather than left to surprise
the operator:

| Loss | How the module handles it |
|---|---|
| Coverage drops to `% Funcs` + `% Lines`, **and untested files are invisible** — Bun has no `coverage.include`, so an orphan module is absent from the table while the total reads 100% | Floor moves to `bunfig.toml`; both losses are documented at the setting and in the generated doc |
| No `json-summary` reporter, so no `COVERAGE.md` | `coverage:readme` and `coverage:open` are simply not shipped |
| No `passWithNoTests` — zero tests is a hard exit 1 | Ships one **real** test that guards the coverage threshold, since nothing else reads `bunfig.toml` |
| `tsc` cannot follow Bun's `vitest` mapping | Ships a `test/vitest-shim.d.ts` + `@types/bun`, and tsconfig renders `types: ["node","bun"]` |

That last one was found by the generation suite, not by reading: the tests passed and the **typecheck**
gate failed, which is the worst kind of split.

Both of those `test/` files ship through `packageSource/`, so under a workspace they land inside the
package. `bunfig.toml` sets `root = "packages"` there, and a test file at the repository root would be
silently skipped — taking the floor guard with it.

## Related

- [`module-contract.md`](module-contract.md) — the five channels, and how to add a module
- [`verification.md`](verification.md) — what proves a module change is correct
