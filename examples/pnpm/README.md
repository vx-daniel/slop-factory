# pnpm

A TypeScript project with one quality gate, a coverage floor, a layered
configuration system, and a set of agent rules under `.claude/` — and no application code, so
the first thing you write is the actual feature.

Agent-facing detail lives in [CLAUDE.md](CLAUDE.md). Per-subsystem reasoning lives in
[docs/](docs/README.md) — one document per module this project was generated with.

## Quick start

```bash
pnpm install        # also wires the pre-commit hook via the `prepare` script
pnpm run check:all  # the gate: Biome → tsc --noEmit → Vitest
```

Both should pass on a clean clone.

```bash
cp .env.example .env                              # then fill in the values
cp config.local.toml.example config.local.toml    # optional; only if you need overrides
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm run check:all` | The gate. Run this before declaring any change done. |
| `pnpm run lint` / `lint:fix` | Biome check / autofix. |
| `pnpm run format` | Biome format, writing changes. |
| `pnpm run typecheck` | `tsc --noEmit`. |
| `pnpm run test` | `vitest run`. |
| `pnpm run coverage` | Coverage + regenerate `COVERAGE.md`. Enforces the 85% floor. |
| `pnpm run coverage:open` | Open the HTML coverage report. |
| `pnpm run coverage:readme` | Update the totals block in this README. |

## How the pieces fit

Each choice below is deliberate and several are non-obvious. If you are about to "simplify" one of
them, this is the reasoning you would be discarding.

**One gate, one definition of green.** `scripts/gate.ts` holds a single ordered list of checks.
`check:all` delegates to it; the pre-commit hook and CI both call `check:all`. Nothing has its own
private notion of passing. Adding a project check means appending one entry to `GATES`; every caller
inherits it. Order is cheap-first, so a fast lint failure surfaces before a slow test run. The gate
detects its own package manager, so it works under npm, pnpm, yarn, and Bun alike.

**A passing gate is necessary, not sufficient.** It proves the code compiles and the tests pass. It
does not prove the behaviour is right. Run the affected path and look at the output.

**One coverage floor, all four metrics.** 85% on lines, branches, functions, and statements. A split
floor is where coverage theatre hides. `coverage.include` measures every file matching
`src/**/*.ts`, not only the ones a test imported — otherwise a module with zero tests is
simply absent from the report and the percentage looks healthy.

**`*.io.ts` keeps that floor honest.** A hard floor pushes you toward one of two bad outcomes when
you hit genuine boundary glue: lower the floor, or write fig-leaf tests asserting a mock was called.
Instead, name such a file `*.io.ts` and it is excluded — on the condition that it contains **no
branching and no computation**. Verify those files by running the real thing, not by mocking.

**The naming gate ships with an empty allowlist.** `.biome/naming.grit` flags abbreviations and
single-character names. Its allowlist is empty because an allowlist is *this project's* sanctioned
vocabulary; inheriting one silently legalises abbreviations that mean nothing here.

## Configuration

Three layers, each with one job. The split exists so the first two can be committed or shared
without ever carrying a credential.

| Layer | File | Committed? | Holds |
|---|---|---|---|
| 1 | `config.defaults.toml` | ✅ **yes** | Safe defaults. Every key the schema requires. |
| 2 | `config.local.toml` | ❌ gitignored | Machine-specific overrides. Still no secrets. |
| 3 | `.env` | ❌ gitignored | **Secrets only**, referenced from layers 1–2 *by variable name*. |

Layers 1 and 2 deep-merge **key by key** (local wins) and validate together. Layer 3 never enters the
config object at all.

`config.local.toml` should contain **only the keys you change**. Because the merge is key-by-key, a
`[server]` block setting just `port` leaves the rest at their defaults. Copying the whole defaults
file and editing two lines is the common mistake — it freezes every other value at whatever the
defaults said that day. Arrays **replace** rather than concatenate, so a local list is the complete
new list; concatenation would make it impossible to *shorten* one locally.

### Why secrets are referenced by name

```toml
[services.primary]
apiKeyEnv = "PRIMARY_API_KEY"     # the NAME — never the key
```

```ts
import { getConfig, resolveServiceApiKey } from '@/config/config.js'

const config = getConfig()
// Throws a message naming both the variable and the service if PRIMARY_API_KEY is unset or blank.
const apiKey = resolveServiceApiKey({ serviceName: 'primary', service: config.services.primary })
```

The credential never lands on the config object, so a config dump or a serialized error cannot leak
it. Add the variable to `.env.example` too — it is the only discoverable list of what a fresh clone
needs.

**The shipped `app` / `server` / `limits` / `services` / `features` blocks are a demonstration of the
available patterns, not a starter set to keep.** Delete what you do not need and edit
`src/config/config-schema.ts` to match — the schema is strict everywhere, so a stale key is a hard
error naming its path rather than a silently ignored line. Keep the mechanism: three layers, strict
validation, inferred types, secrets by env-var name.

## Path aliases

`@/*` maps to `./src/*`, so a deep import reads
`@/orders/store.js` rather than `../../../orders/store.js` — and survives the importing file
being moved. The `.js` extension is still required (ESM + `NodeNext`); it resolves to the `.ts` source.

`tsconfig.json`'s `paths` is the **single source of truth**. Three consumers read it rather than
restating it: `tsc` directly, Vitest via `resolve.tsconfigPaths`, and the runtime via
tsx. Add an alias in one place and all three
follow. There is no `baseUrl` — it is deprecated and stops functioning in TypeScript 7.

## Choosing an emit strategy

`tsconfig.json` sets `noEmit: true` and there is no `build` script. This is a real decision deferred
to you, not an omission — the three common answers need incompatible settings:

- **Run TypeScript directly, no build.** Change nothing — this is what the project already does.
- **Ship a library.** Set `"noEmit": false`, `"declaration": true`, `"outDir": "dist"`; add
  `"build": "tsc"` and the `main`/`types`/`exports` fields to package.json.
- **Bundle for a runtime** (browser, Lambda, edge worker, container). Keep `noEmit` — the bundler
  owns the output — and add a `build` script plus a bundler config. Consider appending a `build`
  entry to `GATES` so a bundle that fails to build fails the gate.

Whichever you pick, add the output directory to `.gitignore` (`dist/` is pre-declared).

## First steps in this repo

- [ ] **Replace the example agent-rule examples.** `.claude/rules/` cites generic modules (orders,
  sessions), not your code. A rule pointing at a module that does not exist actively misleads agents.
- [ ] **Replace the example config** and its tests (`src/config/*.test.ts`) as you define your real
  schema. Note the 85% floor is live: the first source file you add without a test fails
  `pnpm run coverage`. That is intended.
- [ ] **Delete the four Viaanix-specific workflows** if this repo is not in that org —
  `claude-pr-review.yml`, `claude-issue-agent.yml`, `secret-scan.yml`, `test-audit.yml`. They
  delegate to `Viaanix/vx-repo-tools` and cannot resolve elsewhere. `ci.yml` and
  `coverage-main.yml` are self-contained and stay.
- [ ] **Pick a test layout.** `vitest.config.ts` accepts both colocated (`src/**/*.test.ts`) and
  separate (`test/**`). Pick one and delete the other glob rather than leaving two conventions live.
- [ ] **Choose an emit strategy** — above.

## Coverage

<!-- COVERAGE-START -->

_No coverage recorded yet. Run `pnpm run coverage` to generate it._

<!-- COVERAGE-END -->

## Requirements

Node **24+** (`engines` in package.json; CI pins 24). `.ts` files run through `tsx` — no build step,
but not bare Node either, because this project uses path aliases. See "Path aliases" above.
