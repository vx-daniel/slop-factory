# Testing and coverage with `bun test`

This project uses **Bun's built-in test runner**. There is no test-framework dependency — the runner is
part of the runtime.

That choice was made deliberately at generation time over the Vitest alternative, and it is a **trade,
not a free win**. This document states both halves so the trade can be revisited on evidence rather
than re-litigated from memory.

## What you get

- **No test-framework dependency.** `vitest` and `@vitest/coverage-v8` are simply absent.
- **Fast startup.** No separate transform pipeline; Bun executes `.ts` directly.
- **The Vitest API works unmodified.** Bun maps the `vitest` import to its own test API:

  ```ts
  import { describe, expect, it } from 'vitest'   // resolves under `bun test`, with vitest NOT installed
  ```

  This is why switching runners later needs **no import rewrites** in any test file — the migration is
  a config change, not a codemod.

## What you gave up

### Two coverage metrics instead of four

Bun reports `% Funcs` and `% Lines`. There is **no branch coverage and no statement coverage**.

This matters more than "two out of four" suggests. **Branch coverage is precisely what a lines-only
number hides**: a suite can execute every line in a function while never taking the `else`, so lines
reads 100% while half the decisions are unexercised. A split or partial floor is where coverage theatre
lives, and this is a partial floor by necessity rather than by choice.

### Untested files are invisible, not counted as zero

This is the bigger of the two coverage gaps, and the one most likely to mislead.

Vitest has `coverage.include`, which measures **every** file matching a glob rather than only the ones a
test happened to import — so a module with no tests appears at 0% and drags the total down. **Bun has no
equivalent option.**

Measured on Bun 1.3.14, in a project generated exactly like this one: adding an untested
`src/orphan.ts` containing a branch left it **absent from the coverage table entirely**, the total still
read `100.00`, and `bun run coverage` still **passed** the 0.85 floor.

So read the floor correctly:

> It tells you the covered files are well covered. It does **not** tell you that all files are covered.

Until Bun grows an `include` option, the compensating practice is to check the coverage table's **file
list**, not only its percentage — a file you expected to see and don't is the finding. This is a real
argument for Vitest on any project where whole-module omissions are a plausible failure, and it is the
main reason Vitest remains the generator's default.

### No `COVERAGE.md`

Bun offers only `text` and `lcov` coverage reporters:

```
--coverage-reporter=<val>   Report coverage in 'text' and/or 'lcov'. Defaults to 'text'.
```

There is no `json-summary`, which is what a committed coverage snapshot would be generated from. So this
project ships **no** `coverage:readme` script, **no** `coverage:open` script, and **no**
`coverage-main.yml` workflow. Coverage is a number you read in the terminal and in CI, not a document in
the repo.

To get `COVERAGE.md` back you would rewrite the generation script to parse `coverage/lcov.info`, or
migrate to Vitest.

### No `passWithNoTests`

Zero test files is a hard `exit 1`, and Bun has no flag to soften it. Since the gate runs `test`, a
project with no tests at all would fail its own gate on day one.

That is why `test/coverage-floor.test.ts` ships. **It is a real test, not a placeholder** — see below.

## The floor lives in `bunfig.toml`

```toml
[test]
coverage = true
coverageThreshold = 0.85
```

Note the units: Bun takes a **fraction** (`0.85`), where Vitest takes a percentage (`85`).

`coverage = true` matters because **the gate runs `bun test`, not `bun test --coverage`**. Without
collection enabled in config, a bare `bun test` reports success on code the floor would have rejected,
and only the separate `coverage` script would catch it.

### Why `test/coverage-floor.test.ts` should stay

It asserts that the threshold above is present, is at least `0.85`, and that collection is enabled.

That is not self-referential busywork: under `bun test` the floor lives in a file **nothing else reads**.
Delete the `coverageThreshold` line and no error appears anywhere — the suite simply stops enforcing
coverage while continuing to report success. This test turns that silent downgrade into a failure.

Mutate `bunfig.toml` and it goes red. That is the test-quality bar (`.claude/skills/test-quality/`), and
this test meets it.

Keep it even once you have real tests. Delete it only if you migrate to Vitest, where the floor lives in
`vitest.config.ts` and is enforced by the `coverage` script directly.

## Commands

| Command | What it does |
|---|---|
| `bun run test` | `bun test` — with coverage collected and the floor enforced, per bunfig.toml. |
| `bun run coverage` | `bun test --coverage` — the same floor, with the coverage table printed. |

The gate (`bun run check:all`) runs `test` as its third step. There is no separate coverage step locally;
CI runs `coverage` explicitly so the table appears in the log.

## Migrating to Vitest later

Cheaper than it looks, because no test file changes:

1. `bun add -d vitest @vitest/coverage-v8`
2. Add `vitest.config.ts` with `coverage.thresholds` at 85 on **all four** metrics, `coverage.include:
   ['src/**/*.ts']`, the `json-summary` reporter, and `passWithNoTests: true`.
3. Change `test` to `vitest run` and `coverage` to `vitest run --coverage`.
4. Delete `bunfig.toml`, `test/coverage-floor.test.ts`, and **`test/vitest-shim.d.ts`** — the floor moves
   into the Vitest config where it is enforced directly, and the real `vitest` package now supplies the
   types the shim was standing in for. Leaving the shim would shadow them. Drop `@types/bun` too unless
   something else needs it, and remove `"bun"` from tsconfig's `types`.
5. Optionally add `scripts/coverage-to-markdown.ts` and a `coverage-main.yml` workflow to restore
   `COVERAGE.md`.

Your existing tests keep working throughout, because they were already written against the Vitest API.

## Writing tests that actually catch bugs

`.claude/skills/test-quality/` is the procedure, and it is framework-adaptive — it detects `bun:test`
and loads the matching reference. Its core discipline is **empirical mutation review**: break the
implementation, confirm a test goes red, revert.

A test that stays green when you break the code it covers is not a test. It is worse than no test,
because it reports safety that does not exist — and a lines-only coverage floor is less likely to catch
that than a four-metric one, which makes the discipline matter more here, not less.
