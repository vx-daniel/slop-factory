# Running on Bun

This project targets **Bun 1.3+**. Bun runs `.ts` natively and resolves tsconfig `paths` natively, so
there is **no build step and no loader** — the tsx layer that a Node-targeted project needs simply does
not exist here.

`bun.lock` is the committed lockfile; every other manager's is gitignored.

Unlike the Node path — where npm and pnpm are two managers over one runtime, and each has its own
document — Bun is **both** the package manager and the runtime, so there is no separate manager doc to
read. Everything about installing and everything about executing is here.

## What works natively

Measured on **Bun 1.3.14 / Node 24.12.0** against this toolchain, not inferred:

| Concern | Under Bun | Note |
|---|---|---|
| `bun install` | ✅ | ~1.8s for this dependency set |
| Running `.ts` directly | ✅ native | **no tsx needed** |
| tsconfig `paths` aliases (`@/*`) | ✅ native | **no loader, no Vite plugin** |
| Biome (lint, format, naming plugin) | ✅ | a standalone binary; the runtime is irrelevant |
| `tsc --noEmit` | ✅ | |
| Vitest via `bun run vitest run` | ✅ | full suite passes |
| `bun test` (Bun's own runner) | ✅ | runs Vitest-API tests unmodified, and genuinely fails on a mutated implementation |
| `scripts/gate.ts` | ✅ | detects Bun as its package manager |
| The config loader | ✅ | `smol-toml` and Zod both work unchanged |

## Test runner — a separate choice from the runtime

Running on Bun does **not** decide which test runner you use. That was asked separately at generation
time, and whichever was chosen has its own document in this folder:

- **`testing-with-vitest.md`** — Vitest kept under Bun. Four coverage metrics, a committed
  `COVERAGE.md`, and `passWithNoTests`.
- **`testing-with-bun-test.md`** — Bun's built-in runner. No test-framework dependency, but coverage
  drops to `% Funcs` and `% Lines` only, and there is no `COVERAGE.md`.

Only one of those two files is present, so whichever you find is the one in force. The short version of
the trade: `bun test` genuinely works — Bun maps the `vitest` import onto its own API, so test files run
unmodified either way — but it offers no `json-summary` coverage reporter and no branch coverage, which
is what the committed coverage snapshot and the four-metric floor are built on.

**Switching later is cheap**, in either direction, because no test file needs editing. See the
"Migrating" section of whichever testing document is present.

## What Bun makes redundant

Two simplifications are already applied, and one is available:

- **No `tsx`.** Not in devDependencies, not in any script.
- **No `engines.node`.** `engines` names Bun instead.
- **`resolve.tsconfigPaths` in `vitest.config.ts` exists only if Vitest is the runner here.** It is what
  makes `@/*` resolve inside Vitest; Bun resolves the aliases itself, so under `bun test` there is no
  such line and no such file.

## The `.js` extension is still mandatory

ESM + `moduleResolution: NodeNext` applies regardless of runtime:

```ts
import { buildOrderSummary } from '@/orders/summary.js'   // not '@/orders/summary'
```

Omitting it is a hard error. Bun being more permissive than Node in other respects does not change
this, because it is `tsc` that enforces it.

## The gate under Bun

`check:all` is `bun scripts/gate.ts` — no loader prefix. The gate detects Bun via two signals: the
`npm_config_user_agent` string when reached through `bun run check:all`, and a `Bun` global when the
script is invoked directly. It prints which manager it chose.

**Do not hardcode a package manager into `scripts/gate.ts`.** Hardcoding `npm` is what broke
`bun scripts/gate.ts` with `Executable not found in $PATH: "npm"` on a Bun-only machine.

## Lockfile discipline

Exactly one lockfile is committed: `bun.lock`. `.gitignore` ignores `package-lock.json`,
`pnpm-lock.yaml`, and `yarn.lock`.

Two committed lockfiles for one `package.json` resolve independently and drift, and nobody notices
until a version differs between a teammate's install and CI. If you migrate away from Bun, invert this
— do not simply add the other file.
