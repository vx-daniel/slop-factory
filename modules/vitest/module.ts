import {
  isBunRuntime,
  type PackageJsonFragment,
  type ProjectAnswers,
  type ProjectModule,
  type RenderedTemplate,
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

  /**
   * `coverage-main.yml`, and only for the Node managers.
   *
   * The gate is HERE rather than in template data because this is a question about whether the file
   * exists at all, and template data can only make a file's contents conditional. A flag cannot decline
   * to create a file.
   *
   * Restricting it to Node is a limitation, not a necessity — issue #3. Nothing in the workflow would
   * break under bun + Vitest now that the install steps are interpolated; it simply has not been
   * verified there, and shipping an unverified push-to-main workflow that commits back to the repository
   * is a worse failure than not shipping it.
   */
  renderedTemplates(answers: ProjectAnswers): readonly RenderedTemplate[] {
    const templates: RenderedTemplate[] = [
      // Rendered rather than copied because its content varies by LAYOUT in a way no data flag can
      // express: under a workspace, `test.include` must be absent rather than different. See the header
      // comment in the template for why this is the one `.ts` file the factory renders.
      {
        templateFile: 'modules/vitest/vitest.config.ts.hbs',
        outputPath: 'vitest.config.ts',
      },
    ]

    if (!isBunRuntime(answers.packageManager)) {
      templates.push({
        templateFile: 'modules/vitest/coverage-main.yml.hbs',
        outputPath: '.github/workflows/coverage-main.yml',
      })
    }

    return templates
  },

  /**
   * `hasCoverageWorkflow` is owned here, alongside the template it describes, so the prose in the
   * generated README and CLAUDE.md cannot claim a workflow that `renderedTemplates` above declined to
   * emit. It was briefly owned by the `node` module, which happened to agree — Node always implies
   * Vitest — but that agreement was a coincidence of the two conditions, and `mergeTemplateData`
   * permits identical values from two modules, so a later divergence would have been silent.
   */
  templateData(answers: ProjectAnswers): Readonly<Record<string, unknown>> {
    return {
      usesVitest: true,
      hasCoverageWorkflow: !isBunRuntime(answers.packageManager),
    }
  },

  packageJsonFragment(answers: ProjectAnswers): PackageJsonFragment {
    const runnerPrefix = typescriptRunnerPrefix(answers.packageManager)
    /**
     * Test discovery under the workspace layout, scoping the scan to `packages/`.
     *
     * MUST appear on BOTH `test` and `coverage`, and the config must carry no `test.include` — the two
     * do not compose, because `test.include` resolves relative to `--dir`. Putting it on only one script
     * is the quieter failure: the gate would pass while `coverage` measured a different set of files.
     *
     * Chosen over a `packages/`-prefixed `test.include` because it also keeps Vitest from walking
     * `scripts/` and the root `node_modules` at startup.
     */
    const testDiscoveryScope = answers.projectStructure === 'monorepo' ? ' --dir packages' : ''

    return {
      scripts: {
        test: `vitest run${testDiscoveryScope}`,
        coverage: `vitest run --coverage${testDiscoveryScope} && ${runnerPrefix} scripts/coverage-to-markdown.ts`,
        'coverage:readme': `${runnerPrefix} scripts/coverage-to-markdown.ts --readme`,
        // Three openers chained because there is no cross-platform one: xdg-open on Linux, open on
        // macOS, start on Windows. Each fails fast when absent, so the chain lands on the right one.
        'coverage:open': 'xdg-open coverage/index.html || open coverage/index.html || start coverage/index.html',
      },
      devDependencies: {
        '@vitest/coverage-v8': VITEST_COVERAGE_VERSION,
        vitest: VITEST_VERSION,
      },
    }
  },
}
