import {
  type PackageJsonFragment,
  type ProjectAnswers,
  type ProjectModule,
  typescriptRunnerPrefix,
} from '../module-contract.js'

const VITEST_VERSION = '^4.1.10'
const VITEST_COVERAGE_VERSION = '^4.1.10'

/**
 * The Vitest test-runner module — selected when `testRunner` is `vitest`, which is always the case
 * under Node and the default under Bun.
 *
 * Owns the whole coverage pipeline, because all of it is Vitest-specific: the 85% floor on four
 * metrics lives in `vitest.config.ts`, `scripts/coverage-to-markdown.ts` reads Vitest's
 * `json-summary` reporter output, and `coverage-main.yml` invokes `vitest` directly to refresh the
 * committed `COVERAGE.md`. Under `bun test` none of those three exist, which is why this is a module
 * rather than part of base.
 */
export const vitestModule: ProjectModule = {
  name: 'vitest',

  documentation: {
    path: 'docs/testing-with-vitest.md',
    title: 'Testing and coverage',
    summary: 'The 85% floor on all four metrics, the `*.io.ts` escape valve, and the reporters.',
  },

  isSelected(answers: ProjectAnswers): boolean {
    return answers.testRunner === 'vitest'
  },

  templateData(): Readonly<Record<string, unknown>> {
    return { usesVitest: true }
  },

  packageJsonFragment(answers: ProjectAnswers): PackageJsonFragment {
    const runnerPrefix = typescriptRunnerPrefix(answers.projectRuntime)

    return {
      scripts: {
        test: 'vitest run',
        coverage: `vitest run --coverage && ${runnerPrefix} scripts/coverage-to-markdown.ts`,
        'coverage:readme': `${runnerPrefix} scripts/coverage-to-markdown.ts --readme`,
        // Three openers chained because there is no cross-platform one: xdg-open on Linux, open on
        // macOS, start on Windows. Each fails fast when absent, so the chain lands on the right one.
        'coverage:open':
          'xdg-open coverage/index.html || open coverage/index.html || start coverage/index.html',
      },
      devDependencies: {
        '@vitest/coverage-v8': VITEST_COVERAGE_VERSION,
        vitest: VITEST_VERSION,
      },
    }
  },
}
