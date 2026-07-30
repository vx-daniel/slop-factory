# The workspace layout

This project is a **workspace** (a monorepo): the root holds no source of its own, and each package
lives under `packages/`.

```
package.json          ← workspace root: "workspaces": ["packages/*"], all devDependencies, the lockfile
tsconfig.json         ← ONE config for every package
vitest.config.ts      ← or bunfig.toml, depending on the runner
config.defaults.toml  ← config stays at the root; the loader walks UP to find it
scripts/              ← repo-wide scripts (the gate, coverage generation)
packages/
  core/
    package.json      ← required: a directory here without one is not a workspace member
    src/
```

## Dependencies live at the root, with one exception

All **devDependencies** and the single lockfile stay at the workspace root. Per-package `node_modules`
and per-package lockfiles are the main source of version skew in a monorepo — two packages resolving the
same library to different versions, with nothing reporting it.

The exception is **runtime** dependencies, which belong in the `package.json` of the package that imports
them. That keeps each package honest about what it actually needs, which matters the day one is published
or extracted.

## One alias per package

`tsconfig.json` declares an alias per package:

```jsonc
"paths": {
  "@core/*": ["./packages/core/src/*"]
}
```

```ts
import { buildOrderSummary } from '@core/orders/summary.js'   // across packages
import { formatTotal } from './format.js'                     // within a package
```

**Adding a package means adding an entry here.** That is the acknowledged cost of this approach. The
alternative — importing packages by their `package.json` name (`@your-project/core/...`) — needs no
`paths` upkeep, but it only resolves once the workspace has been installed and linked, and each package
must then declare an `exports` map to expose subpaths. Aliases resolve straight from `tsconfig.json`,
before any install, which is why they are what this ships.

**There is exactly one `tsconfig.json`, and no per-package config extending it.** That is deliberate:
`paths` entries resolve relative to the file that *declares* them, so a per-package config extending a
base is the classic way to end up with mappings that are subtly wrong. With one file there is nothing to
get wrong.

Project references (`tsc -b`) are also deliberately absent. They require each referenced package to emit
declarations — `composite` + `declaration` + `outDir` — which contradicts the blanket `noEmit` this
blueprint ships and would force an emit-strategy decision the blueprint deliberately leaves to you. One
config over every package is simpler and slower; it is fine until the repo is large.

## Test discovery is scoped, and the mechanisms do not mix

Discovery is scoped to `packages/`, so the runner never walks `scripts/` or the root `node_modules`.
**How** it is scoped depends on the runner, and in both cases there is exactly one mechanism — mixing two
is the most likely thing to break here.

### Under Vitest

`--dir packages` on the command line, in **both** the `test` and `coverage` scripts. `vitest.config.ts`
therefore carries **no `test.include`**, and must not gain one:

| Config | Result |
|---|---|
| `--dir packages`, no `test.include` | tests found, coverage correct |
| `test.include` prefixed with `packages/`, no `--dir` | tests found, coverage correct |
| **both** | `No test files found`, exit 1, coverage 0% |

`test.include` is resolved *relative to* `--dir`, so the two stack into
`packages/packages/*/src/**/*.test.ts`. It fails loudly rather than silently, but the message names only
the unmatched glob — not the doubling — so it reads like a broken path.

`coverage.include` is unaffected and keeps its `packages/` prefix: it resolves from the project root, not
from `--dir`.

### Under `bun test`

`root = "packages"` in `bunfig.toml`. Bun has no `--dir`, and its positional forms are not
interchangeable — measured on Bun 1.3.14:

| Command | Behaviour |
|---|---|
| `bun test packages` | path **substring** match — also runs `scripts/packages-helper.test.ts` |
| `bun test ./packages` or `bun test packages/` | real directory scope |

Setting `root` in config avoids having to remember which form is which.

**Consequence:** every test file must live under `packages/`. That is why the coverage-floor guard and
the `vitest` type shim are at `packages/<name>/test/` rather than at the repository root — at the root
they would be silently skipped, and the guard that exists to stop the floor being deleted would itself
stop running.

## Coverage aggregates across packages

One floor, measured over every package's source. A single number still means one thing repo-wide, but be
aware of what it hides: a well-covered package can mask a weak one.

If that becomes a problem, reach for **per-file thresholds** — not a lower floor. Lowering a floor to
absorb a new package's untested code hides a real regression in the packages that were already fine. The
ratchet only turns up.

## Adding a package

1. `mkdir -p packages/<name>/src`
2. Add `packages/<name>/package.json` — copy `packages/core/package.json` and change the name. Without
   it, the directory is not a workspace member and the manager ignores it.
3. Add its alias to `paths` in `tsconfig.json`.
4. Install from the **root**, not from inside the package.

Steps 2 and 3 are the ones that get forgotten, and both fail in a way that points somewhere else: a
missing `package.json` looks like a dependency problem, and a missing alias looks like a broken import.

## When to add a task runner (Turborepo, Nx)

**Not yet, and adding one now would cost more than it returns.** What those tools optimise, this project
does not currently have:

| What a task runner gives you | This project |
|---|---|
| Caching build outputs | there is no build step — `noEmit`, and `.ts` runs directly |
| Parallel per-package tasks | `typecheck` is one `tsc --noEmit` over every package — one process |
| Parallel test runs | one runner invocation already covers every package |
| A task graph (`dependsOn`) | one package |

There is also a concrete conflict: `scripts/coverage-to-markdown.ts` reads a **single**
`coverage/coverage-summary.json`. Per-package task runs produce per-package outputs, so adopting one
means either merging N summaries — a step that does not exist — or running the test suite once anyway,
with the task runner wrapping something it cannot cache.

Revisit when **either** becomes true:

- Packages gain real build steps (`tsup`, `esbuild`, bundling for a runtime), so there is genuinely
  something to cache; or
- There are enough packages that per-task caching beats one process — in practice when a full
  `check:all` becomes slow enough that you avoid running it.

Until then the cost is a config file, a dependency, and a layer between you and the tool that reports
your errors.
