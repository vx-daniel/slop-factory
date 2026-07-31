# CLAUDE.md — bun

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
bun run check:all   # THE gate: Biome → tsc --noEmit → tests (cheap-first)
bun run coverage    # bun test --coverage; enforces the 85% floor from bunfig.toml
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
- **Coverage** — the 85% floor lives in `bunfig.toml` (`[test] coverageThreshold = 0.85`), because
  `bun test` does not read `vitest.config.ts`. **Bun reports only `% Funcs` and `% Lines`** — there is
  no branch or statement coverage, so this is a genuinely weaker floor than the four-metric Vitest
  one, and branch coverage is exactly what a lines-only number hides. `coverage = true` is set so a
  bare `bun test` (what the gate runs) enforces the floor too, not just `--coverage`.
- **`test/coverage-floor.test.ts` guards the floor and should stay.** Under `bun test` the threshold
  lives in a file nothing else reads: delete the line and no error appears anywhere, the suite just
  stops enforcing coverage while still reporting success. That test turns the silent downgrade into a
  failure. It is also why the project has at least one test at all — `bun test` has no
  `passWithNoTests`, so zero test files is a hard exit 1.
- **There is no `COVERAGE.md`, and no `coverage:readme` / `coverage:open`.** Bun offers no
  `json-summary` reporter to generate them from. See [docs/testing-with-bun-test.md](docs/testing-with-bun-test.md).
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

- **Bun 1.3+.** Bun runs `.ts` natively and resolves tsconfig `paths` natively, so there is no
  loader and no build step. `bun.lock` is the committed lockfile.
- **`bun test` is the runner, chosen at generation time over Vitest.** No test-framework dependency at
  all. Bun maps the `vitest` import to its own API, so test files written against the Vitest API run
  unmodified — which also means migrating to Vitest later needs no import rewrites.
- **The gate detects its own package manager** (`npm_config_user_agent`, falling back to a `Bun`
  global check, then npm) and prints which it chose. Do not hardcode a manager back into
  `scripts/gate.ts` — that is what broke `bun scripts/gate.ts` with
  `Executable not found in $PATH: "npm"`.
- **TypeScript 7**, `strict: true`, typecheck-only.
- **Path aliases**: `@/*` → `./src/*`. `tsconfig.json`'s
  `paths` is the **single source of truth** —
  tsc reads it directly, `bun test` natively, runtime via Bun.
  Add an alias there and all consumers follow; never restate the mapping elsewhere. There is
  deliberately no `baseUrl` (deprecated, stops working in TS 7).
- **ESM** (`"type": "module"`, `moduleResolution: NodeNext`): imports **must** carry a `.js`
  extension — `'./thing.js'` and `'@/orders/store.js'` both resolve to the `.ts` source. Omitting it
  is a hard error, not a warning.
- **Biome** for lint/format, **`bun test`** for tests, **Zod 4**
  for boundary validation.

## Known caveats — read before relying on these

- **`secret-scan.yml` needs no secret and no setup.** It uses the MIT gitleaks binary and the
  automatically-provided `github.token`. It scans only a pull request's new commits, never the whole tree,
  so it is safe to mark as a required check on an existing repository without red-X'ing open work.
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
