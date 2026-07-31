import {
  type PackageJsonFragment,
  type ProjectAnswers,
  type ProjectModule,
  pathVocabulary,
  type RenderedTemplate,
} from '../module-contract.js'

const NODE_TYPES_VERSION = '^24.10.1'

/**
 * The base module — always selected, and the only module that is not optional.
 *
 * It carries what every generated project needs regardless of runtime, test runner, or features: the
 * tsconfig, the agent rules and skills under `.claude/`, the pre-commit hook, and the four
 * organisation-specific workflow stubs.
 *
 * It deliberately owns NO tooling. Biome belongs to the gate module, the test runner and its coverage
 * pipeline to `vitest` or `bun-test`, and `.ts` execution to `node` or `bun` — so each of those can be
 * swapped without base leaving a dangling script behind.
 *
 * `ci.yml` IS owned here, which is a change from when there was one verbatim copy per runtime module.
 * Every generated project gets the same workflow; the parts that vary by package manager (the setup
 * steps and the install command) are interpolated from template data the manager modules contribute.
 * Three near-identical 50-line copies was the alternative.
 *
 * `@types/node` is the one exception, and it is not really tooling: `tsconfig.json` sets
 * `"types": ["node"]`, so omitting the package fails `tsc --noEmit` with "Cannot find type definition
 * file for 'node'" under either runtime and either test runner.
 */
export const baseModule: ProjectModule = {
  name: 'base',

  documentation: {
    path: 'docs/typescript-setup.md',
    title: 'TypeScript setup',
    summary: 'Path aliases, the mandatory `.js` extension, strictness, and choosing an emit strategy.',
  },

  isSelected(): boolean {
    return true
  },

  /**
   * The path vocabulary its own prose templates interpolate — see `pathVocabulary`.
   *
   * Owned here because base owns `CLAUDE.md.hbs` and `README.md.hbs`, the two documents that tell a
   * reader where things are. Deliberately NOT owned by the `monorepo` module: these keys have a correct
   * value under BOTH layouts, and a module that is absent under `single` cannot supply one. `monorepo`
   * contributes the facts only it knows (`isMonorepo`, `packageNames`); base contributes the paths
   * derived from them.
   */
  templateData(answers: ProjectAnswers): Readonly<Record<string, unknown>> {
    return pathVocabulary(answers)
  },

  /**
   * The documents whose content depends on the answers, so they cannot come from the verbatim `source/`
   * tree. They live at the module root, physically outside `source/`, so a file cannot be rendered by
   * accident — see the `{{ }}` collision with GitHub Actions documented in `module-contract.ts`.
   *
   * `docs/README.md` is the odd one out: it is the only file whose content depends on WHICH modules were
   * selected rather than on any single answer, which is why the generator supplies `documentedModules`
   * rather than a module doing it.
   */
  renderedTemplates(): readonly RenderedTemplate[] {
    return [
      { templateFile: 'modules/base/gitignore.hbs', outputPath: '.gitignore' },
      // Rendered because two fields depend on the test runner: `types` needs `bun` under `bun test`, and
      // `include` must not name a vitest.config.ts that is not there.
      { templateFile: 'modules/base/tsconfig.json.hbs', outputPath: 'tsconfig.json' },
      { templateFile: 'modules/base/CLAUDE.md.hbs', outputPath: 'CLAUDE.md' },
      { templateFile: 'modules/base/README.md.hbs', outputPath: 'README.md' },
      { templateFile: 'modules/base/docs-index.md.hbs', outputPath: 'docs/README.md' },
      // Rendered rather than copied, unlike every other workflow in `source/.github/workflows/`. That
      // makes it the one file where the Handlebars / GitHub Actions `{{ }}` collision is live, which is
      // why the template escapes `$\{{ github.ref }}` and a test asserts the expression survives intact.
      { templateFile: 'modules/base/ci.yml.hbs', outputPath: '.github/workflows/ci.yml' },
    ]
  },

  packageJsonFragment(): PackageJsonFragment {
    return {
      scripts: {
        // Points git at the committed `.githooks/` directory so the pre-commit gate is active after
        // a plain install, with no separate "run this to wire the hook" step for a new clone to
        // miss. `|| true` keeps installs from failing outside a git work tree — installing inside a
        // tarball or a Docker build context is legitimate and must not hard-error.
        prepare: 'git config core.hooksPath .githooks || true',
      },
      devDependencies: {
        '@types/node': NODE_TYPES_VERSION,
      },
    }
  },
}
