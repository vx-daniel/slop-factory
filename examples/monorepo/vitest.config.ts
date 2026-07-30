import { defineConfig } from 'vitest/config'

// The coverage floor the gate enforces. All four metrics share one number deliberately: a split
// floor (e.g. lines 85 / branches 60) is where coverage theatre hides — a suite can hit a high line
// number while leaving most decision paths unexercised. Raise this as the project matures; the
// ratchet only turns one way (see .claude/rules/broken-windows.md).
const COVERAGE_FLOOR_PERCENT = 85

export default defineConfig({
  // Resolves the `paths` aliases from tsconfig.json rather than restating them here — without it an
  // aliased import typechecks but fails to resolve at test time. This is Vite's NATIVE support; the
  // `vite-tsconfig-paths` plugin does the same job and is the answer most search results still give,
  // but it is redundant here and Vitest logs a notice telling you to remove it.
  resolve: { tsconfigPaths: true },
  test: {
    // NO `include` HERE, DELIBERATELY, AND DO NOT ADD ONE. Test discovery comes from `--dir packages`
    // in the `test` and `coverage` scripts, and the two mechanisms do not compose: `test.include` is
    // resolved RELATIVE TO `--dir`, so a `packages/`-prefixed include stacks up into
    // `packages/packages/*/src/**/*.test.ts` and matches nothing.
    //
    // Measured on the generated workspace:
    //
    //   | Config                              | Result                                        |
    //   |-------------------------------------|-----------------------------------------------|
    //   | `--dir packages`, no `test.include` | tests found, coverage correct                 |
    //   | `test.include` prefixed, no `--dir` | tests found, coverage correct                 |
    //   | both                                | `No test files found`, exit 1, coverage 0%    |
    //
    // It does fail loudly rather than passing silently — but the message names only the unmatched
    // glob, not the doubling, so it reads like a broken path and sends you to the wrong place.
    //
    // `coverage.include` below is unaffected and KEEPS its `packages/` prefix: it is resolved from the
    // project root, not from `--dir`.

    // A freshly generated project has no source code and therefore no tests, and Vitest's default
    // is to treat "no test files found" as exit code 1 — which would make the gate RED on day one,
    // before a single line has been written. Zero tests is the correct state for an empty project,
    // so it must not read as a failure.
    //
    // This does NOT lose the signal it normally provides (a glob that stopped matching). The
    // coverage floor is the backstop: if the include globs break once tests exist, the suite stops
    // running, coverage drops to 0%, and `coverage` fails the 85% threshold. CI runs BOTH
    // `check:all` and `coverage` (see .github/workflows/ci.yml), so a silently-empty suite still
    // fails the build — one gate later than it otherwise would, but it does fail.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',

      // `json-summary` is REQUIRED, not cosmetic: scripts/coverage-to-markdown.ts reads
      // coverage/coverage-summary.json to build COVERAGE.md. Dropping it breaks `npm run coverage`
      // and the coverage-main.yml workflow.
      //
      // The rest are each for one audience: `text` is the per-file table during a run,
      // `text-summary` the compact totals line at the end (the number you actually read),
      // `html` backs `npm run coverage:open`, and `lcov` feeds editor gutter extensions — VS Code's
      // Coverage Gutters and friends read coverage/lcov.info, which turns coverage from a report
      // you go look at into an annotation on the line you are editing.
      reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov'],

      // Stated explicitly rather than left to the default, because it is a CONTRACT, not a
      // preference: scripts/coverage-to-markdown.ts and .github/workflows/coverage-main.yml both
      // hardcode `coverage/`. Moving this silently breaks both.
      reportsDirectory: './coverage',

      // `include` measures every matching source file, NOT just the ones a test happened to import.
      // That distinction is the whole point: a module with zero tests must appear in the report at
      // 0% rather than being absent, which is the most common way a coverage floor gets silently
      // defeated. (Vitest ≤2 needed `all: true` for this; the option was removed in Vitest 3+ and is
      // a type error here — setting `include` is now sufficient. Verified by adding an untested
      // src/ file and watching the floor fail.)
      //
      // Under the workspace layout this spans EVERY package, so coverage aggregates repo-wide and the
      // single floor below keeps meaning one thing. A well-covered package can still mask a weak one in
      // an aggregate number — if that becomes a problem, reach for `perFile` thresholds rather than
      // lowering the floor.
      include: ['packages/*/src/**/*.ts'],

      // What is deliberately NOT measured. Every entry needs a reason — an exclude is the easiest
      // way to fake a coverage number, so the bar is "this file cannot meaningfully be unit-tested",
      // never "this file is inconvenient to test".
      //
      //   *.test.ts   the tests themselves.
      //   types.ts    type-only modules; they erase at runtime, so there is nothing to execute.
      //   *.d.ts      declarations, same reason.
      //   *.io.ts     THE IMPERATIVE SHELL — see below. Ships as a convention, not a loophole.
      //
      // `*.io.ts` marks side-effecting boundary glue: the process bootstrap, an HTTP handler that
      // only wires request → pure function → response, a database call, a console/fs write. The
      // rule that makes the exclusion honest is that such a file contains **no branching and no
      // computation** — every decision is pushed down into a pure module that IS covered. If you
      // find yourself wanting an `if` in an `.io.ts`, that condition belongs in a tested function.
      //
      // Without an escape valve like this, an 85% floor pushes adopters toward one of two worse
      // outcomes: lowering the floor, or writing fig-leaf tests that assert a mock was called. This
      // gives the boundary somewhere legitimate to live. Verify shells by running the real thing —
      // see .claude/skills/test-quality/ on why "it was mocked" is not evidence.
      exclude: [
        'packages/*/src/**/*.test.ts',
        'packages/*/src/**/types.ts',
        'packages/*/src/**/*.d.ts',
        'packages/*/src/**/*.io.ts',
      ],

      thresholds: {
        lines: COVERAGE_FLOOR_PERCENT,
        branches: COVERAGE_FLOOR_PERCENT,
        functions: COVERAGE_FLOOR_PERCENT,
        statements: COVERAGE_FLOOR_PERCENT,
      },
    },
  },
})
