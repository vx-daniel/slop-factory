# CLAUDE.md — node-pnpm

Generated from the project factory. This file describes **this project**, not the factory — if you
find factory or "blueprint" framing anywhere in this repo, that is a stale file and a bug worth
fixing, because agents act on what they read here.

There is no application code yet. Everything below exists so the first feature you write lands in a
repo that already has one definition of "green".

**[`docs/`](docs/) carries the reasoning per subsystem** — one document per module this project was
generated with, indexed in [docs/README.md](docs/README.md). Read the relevant one before changing a
configured behaviour; each explains why a setting is what it is, which is what stops a "simplification"
from removing something load-bearing.

## Verification (run before declaring any change done)

```bash
pnpm run check:all   # THE gate: Biome → tsc --noEmit → tests (cheap-first)
pnpm run coverage    # v8 coverage + regenerates COVERAGE.md; enforces the 85% floor
```

`check:all` is the single source of "green". **A passing gate is necessary but not sufficient** — it
proves the code compiles and the tests pass, not that the behaviour is right. Run the affected path
and look at the output. This is the rule most often skipped, including by agents.

## What's here

- **The gate** — `scripts/gate.ts`. One ordered list of checks, cheap-first, so a two-second lint
  failure surfaces before a slow test run. Both the pre-commit hook (`.githooks/pre-commit`, wired by
  the `prepare` script) and CI (`.github/workflows/ci.yml`) invoke `check:all`, so "works on my
  machine" and "CI is green" cannot diverge. **Adding a project check — a build, an IaC synth, a
  container smoke test — means appending one entry to `GATES` and nothing else.**
- **Lint + format** — Biome (`biome.json`), `recommended` plus stricter overrides: no nested
  ternaries, no `any`, no `@ts-ignore`, numeric separators required.
- **The naming gate** — `.biome/naming.grit`, a GritQL plugin registered via biome.json's `plugins`
  key. Flags abbreviations and single-character names that Biome's `useNamingConvention`
  structurally cannot catch, because it checks case, not length. **Its allowlist ships empty on
  purpose** — an allowlist is a specific project's sanctioned vocabulary, and an inherited one
  silently legalises abbreviations that mean nothing here. Add entries only with a receipt: the
  published field name, the spec term.
- **Coverage** — `vitest.config.ts` sets an 85% floor on **all four** metrics. A split floor (lines
  85 / branches 60) is where coverage theatre hides: a suite can post a high line number while
  leaving most decision paths unexercised. `coverage.include` measures every file matching
  `src/**/*.ts`, not only the ones a test imported — without it a module with zero tests is
  absent from the report rather than showing 0%.
- **`*.io.ts` is the escape valve that keeps the floor honest.** Name a file `*.io.ts` and it is
  excluded from the metric, on one condition: **it contains no branching and no computation.** It is
  for boundary glue — process bootstrap, a handler that only wires request → pure function →
  response, a database write. Every decision belongs in a pure module that *is* covered. If you want
  an `if` in an `.io.ts`, that condition belongs in a tested function. This is a convention, not a
  loophole: do not rename a file to dodge the floor.
- **Agent rules** — `.claude/rules/`. Naming, TypeScript patterns, Zod, options objects, discipline,
  broken windows, memory. Read the relevant one before writing code in its area. Each file states
  whether it is mechanically gated or review-enforced, so a green gate is never mistaken for "the
  conventions are met".
- **Agent skills** — `.claude/skills/`: `test-quality` (writing and reviewing tests, including the
  mutation-review discipline) and the two-index memory system.
- **Configuration** — three layers, each with one job: `config.defaults.toml` (committed, safe
  defaults), `config.local.toml` (gitignored, machine-specific), `.env` (gitignored, **secrets
  only**). The first two deep-merge **key by key** and validate together; the third never enters the
  config object. Secrets are referenced **by variable name** via `apiKeyEnv` and read at the point of
  use, so a config dump, a log line, or a serialized error cannot leak one.
  `src/config/config-schema.ts` is the strict Zod contract with **no I/O** (it
  unit-tests against plain objects, no fixtures); `src/config/config.ts` does
  find → merge → validate with the filesystem and environment injected.
  Use `getConfig()`, never a module-level `const` — a top-level `export const config = loadConfig()`
  makes merely *importing* the module touch the filesystem, forcing real TOML on disk into every test
  that transitively imports it.

## What's deliberately NOT here

Absent by design. Do not treat these as gaps to fill unless this project needs them:

- **No build script and no emit config.** `tsconfig.json` sets `noEmit` — a library, a bundled app,
  and a directly-executed script want three incompatible answers. Pick one when you know which this
  is; see README.md.
- **No framework, runtime, or cloud SDK.** Add what the project needs, nothing pre-emptively.
- **No `.claude/memory/`.** Created by the `sync-project-memory` skill on first run.

## Toolchain

- **Node 24+** (`engines` in package.json; CI pins 24), running `.ts` through **tsx**
  (`node --import tsx scripts/gate.ts`) — no build step. **Do not "simplify" this to bare `node`**:
  Node's own resolver does not read tsconfig `paths`, so the first aliased import throws
  `ERR_MODULE_NOT_FOUND`. tsx is load-bearing, not ceremony. `package-lock.json` is the committed
  lockfile.
- **The gate detects its own package manager** (`npm_config_user_agent`, falling back to a `Bun`
  global check, then npm) and prints which it chose. Do not hardcode a manager back into
  `scripts/gate.ts` — that is what broke `bun scripts/gate.ts` with
  `Executable not found in $PATH: "npm"`.
- **TypeScript 7**, `strict: true`, typecheck-only.
- **Path aliases**: `@/*` → `./src/*`. `tsconfig.json`'s
  `paths` is the **single source of truth** —
  tsc reads it directly, Vitest via `resolve.tsconfigPaths`, runtime via tsx.
  Add an alias there and all consumers follow; never restate the mapping elsewhere. There is
  deliberately no `baseUrl` (deprecated, stops working in TS 7).
- **ESM** (`"type": "module"`, `moduleResolution: NodeNext`): imports **must** carry a `.js`
  extension — `'./thing.js'` and `'@/orders/store.js'` both resolve to the `.ts` source. Omitting it
  is a hard error, not a warning.
- **Biome** for lint/format, **Vitest** for tests, **Zod 4**
  for boundary validation.

## Known caveats — read before relying on these

- **Four workflows are Viaanix-org-specific.** `claude-pr-review.yml`, `claude-issue-agent.yml`,
  `secret-scan.yml`, and `test-audit.yml` are caller stubs pointing at
  `Viaanix/vx-repo-tools/.github/workflows/...@v1`. **Outside that org they cannot resolve**, and
  three of the four also need the org secret `CLAUDE_CODE_OAUTH_TOKEN_TOOLING`. If this project is
  not in the Viaanix org, delete those four files — `ci.yml` and
  `coverage-main.yml` stand alone.
- **Committed agent memory is not auto-loaded.** `.claude/rules/agent-memory.md` describes the
  two-index system, but this repo has no `@import` of the memory index in this file, so committed
  memory is a shared artifact you must open explicitly. Don't write rules or PR text assuming
  auto-load.
- **The agent rules arrived from elsewhere and their examples are generic.** They cite orders and
  sessions, not this project's modules. A rule citing a module that does not exist actively misleads
  — re-fit the examples to real code once you have some. `.claude/rules/broken-windows.md`
  § "Don't Broaden Scope While Cleaning" documents this as a repeated, real cost.

## Conventions

The files in `.claude/rules/` are the detail; the short version:

- **Verbose names, no abbreviations.** Gated by the naming plugin, not just review.
- **Comments carry WHY; names carry WHAT.** Both required when the why is non-obvious.
- **Plain over clever.** No nested ternaries (gated), no one-line pipeline gymnastics.
- **Options objects at 3+ parameters.** Biome's `useMaxParams` fails at 4; the rule is stricter at 3
  and review-enforced, so a green gate does not mean the convention is met.
- **Zod at trust boundaries**, with the type *inferred* from the schema — never hand-written beside it.
- **No magic values**, no abandonment markers (`TODO`/`FIXME`/`HACK`), no test weakening, no type
  suppression in tests.
