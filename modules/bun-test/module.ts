import type { PackageJsonFragment, ProjectAnswers, ProjectModule } from '../module-contract.js'

const BUN_TYPES_VERSION = '^1.3.14'

/**
 * Bun's own test runner — selected when `testRunner` is `bun-test`, which is only offered under the
 * Bun runtime.
 *
 * Contributes NO test-framework dependency, which is the point: `bun test` is built into the runtime.
 * Bun also maps the `vitest` import to its own API, so test files written against the Vitest API run
 * unmodified — a project can switch runners without rewriting a single import.
 *
 * What it gives up, and why each is handled here rather than left to surprise the operator:
 *
 *   - **A materially weaker coverage floor**, in two ways, both measured on Bun 1.3.14 rather than
 *     assumed. First, Bun reports `% Funcs` and `% Lines` only — no branch or statement coverage, and
 *     branch coverage is what a lines-only number most effectively hides. Second, and worse, Bun
 *     measures ONLY files a test imports: there is no equivalent of Vitest's `coverage.include`, so an
 *     untested `src/orphan.ts` is absent from the table entirely, the total still reads 100%, and the
 *     floor still passes. The floor therefore certifies that covered files are well covered, not that
 *     all files are covered.
 *   - **No `COVERAGE.md`.** Bun has no `json-summary` reporter, so there is no
 *     `coverage:readme`/`coverage:open` script. (`coverage-main.yml` is absent under Bun for a separate
 *     reason — it is npm-specific and lives in the node module.)
 *   - **No `passWithNoTests`.** Zero test files is a hard exit 1 with no flag to soften it, so this
 *     module ships one real test that guards the coverage floor itself. See `test/coverage-floor.test.ts`.
 */
export const bunTestModule: ProjectModule = {
  name: 'bun-test',

  documentation: {
    path: 'docs/testing-with-bun-test.md',
    title: 'Testing and coverage',
    summary: "Bun's runner, the weaker coverage floor in bunfig.toml, and what was traded away.",
  },

  isSelected(answers: ProjectAnswers): boolean {
    return answers.testRunner === 'bun-test'
  },

  /**
   * Contributed EXPLICITLY as false rather than omitted. The templates branch on `usesVitest` in both
   * directions, and stating it keeps the two runner modules symmetrical — reading either one tells you
   * what the templates will do, without having to know that a missing key means false.
   */
  templateData(): Readonly<Record<string, unknown>> {
    return { usesVitest: false }
  },

  packageJsonFragment(): PackageJsonFragment {
    return {
      devDependencies: {
        // Needed by `test/vitest-shim.d.ts`, which forwards the `vitest` module specifier to
        // `bun:test` so test files typecheck. Bun maps that specifier at RUNTIME, but `tsc` cannot
        // follow the mapping — without the shim and these types, every test file fails typecheck with
        // "Cannot find module 'vitest'" while the tests themselves pass.
        '@types/bun': BUN_TYPES_VERSION,
      },
      scripts: {
        test: 'bun test',
        // The threshold lives in bunfig.toml (`[test] coverageThreshold`), not on this command line,
        // so `bun test` and `bun test --coverage` agree on the floor and there is one place to raise it.
        coverage: 'bun test --coverage',
      },
    }
  },
}
