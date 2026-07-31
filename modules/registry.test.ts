import { access } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_FIRST_PACKAGE_NAME, PROJECT_STRUCTURES, type ProjectAnswers } from './module-contract.js'
import { PROJECT_MODULES } from './registry.js'

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')

/** The manager modules, one of which must be selected for any answer set. */
const MANAGER_MODULES = ['npm', 'pnpm', 'bun'] as const

/** The mutually-exclusive test-runner modules. */
const TEST_RUNNER_MODULES = ['vitest', 'bun-test'] as const

/**
 * Every combination the prompts can actually produce.
 *
 * `bun-test` appears only with the bun manager, because the prompt is skipped for npm and pnpm and
 * `toProjectAnswers` forces `vitest` there — asserting an npm + bun-test combination would be asserting
 * behaviour for an answer set the generator cannot produce.
 */
const MANAGER_AND_RUNNER_COMBINATIONS = [
  { packageManager: 'npm', testRunner: 'vitest', enableFeatures: [] },
  { packageManager: 'npm', testRunner: 'vitest', enableFeatures: ['config'] },
  { packageManager: 'pnpm', testRunner: 'vitest', enableFeatures: [] },
  { packageManager: 'pnpm', testRunner: 'vitest', enableFeatures: ['config'] },
  { packageManager: 'bun', testRunner: 'vitest', enableFeatures: [] },
  { packageManager: 'bun', testRunner: 'vitest', enableFeatures: ['config'] },
  { packageManager: 'bun', testRunner: 'bun-test', enableFeatures: [] },
  { packageManager: 'bun', testRunner: 'bun-test', enableFeatures: ['config'] },
] as const

/**
 * Every answer set the prompts can produce, across BOTH layouts.
 *
 * The layout is a genuine third axis rather than a variant, so it multiplies: `monorepo` selects an extra
 * module that contributes its own template data and its own output path, and the checks below — one
 * manager, one runner, no duplicate output path, no template-data conflict — are exactly the ones that
 * catch a new module colliding with an existing one.
 *
 * Iterating only `single` would have left the `monorepo` module's contributions unchecked while every
 * assertion still passed, which is the failure this list exists to prevent.
 */
const REACHABLE_ANSWERS = PROJECT_STRUCTURES.flatMap((projectStructure) =>
  MANAGER_AND_RUNNER_COMBINATIONS.map((combination) => ({ ...combination, projectStructure })),
)

/**
 * Fills in the answer fields these assertions deliberately do not vary.
 *
 * `projectStructure` is `single` because that is the only value the prompts can produce — see
 * `PROJECT_STRUCTURES`. The monorepo layout is a separate axis and is exercised where it is observable,
 * in the generation tests, which supply the answer directly.
 *
 * Extracted rather than spread inline at each call site, because there were seven of them and adding a
 * field to `ProjectAnswers` had to be a one-line change here rather than seven identical edits.
 */
function toFullAnswers(answers: (typeof REACHABLE_ANSWERS)[number]): ProjectAnswers {
  return {
    projectName: 'example',
    projectPath: '/tmp',
    firstPackageName: DEFAULT_FIRST_PACKAGE_NAME,
    ...answers,
  }
}

describe('module registry', () => {
  it('registers at least the always-on modules', () => {
    const names = PROJECT_MODULES.map((projectModule) => projectModule.name)

    expect(names).toContain('base')
    expect(names).toContain('gate')
  })

  it('gives every module a unique name', () => {
    // Names are the provenance in package.json conflict messages; a duplicate makes those messages
    // ambiguous exactly when they matter most.
    const names = PROJECT_MODULES.map((projectModule) => projectModule.name)

    expect(new Set(names).size).toBe(names.length)
  })

  it('selects exactly one manager module for every reachable answer set', () => {
    // Two selected managers would contribute conflicting install commands; zero would leave the project
    // with no CI workflow and no engines field. Both are silent failures without this check.
    for (const answers of REACHABLE_ANSWERS) {
      const selectedManagerModules = PROJECT_MODULES.filter(
        (projectModule) =>
          projectModule.isSelected(toFullAnswers(answers)) &&
          MANAGER_MODULES.some((moduleName) => moduleName === projectModule.name),
      )

      expect(selectedManagerModules.map((projectModule) => projectModule.name)).toEqual([answers.packageManager])
    }
  })

  it('selects exactly one test-runner module for every reachable answer set', () => {
    // Two selected test runners would conflict on the `test` script — which the merge would throw on,
    // but at generation time rather than here.
    for (const answers of REACHABLE_ANSWERS) {
      const selectedTestRunnerModules = PROJECT_MODULES.filter(
        (projectModule) =>
          projectModule.isSelected(toFullAnswers(answers)) &&
          TEST_RUNNER_MODULES.some((moduleName) => moduleName === projectModule.name),
      )

      expect(selectedTestRunnerModules.map((projectModule) => projectModule.name)).toEqual([answers.testRunner])
    }
  })

  it('always provides a `test` and a `coverage` script, whichever runner is chosen', async () => {
    // `scripts/gate.ts` runs `test` and the CI workflow runs `coverage`. A combination that omits
    // either produces a project whose own gate or CI fails on a missing script.
    const { mergePackageJsonFragments } = await import('./module-contract.js')

    for (const answers of REACHABLE_ANSWERS) {
      const fullAnswers = toFullAnswers(answers)
      const merged = mergePackageJsonFragments(
        PROJECT_MODULES.filter((projectModule) => projectModule.isSelected(fullAnswers)).map((projectModule) => ({
          moduleName: projectModule.name,
          fragment: projectModule.packageJsonFragment(fullAnswers),
        })),
      )

      expect(merged.scripts, `${answers.packageManager}/${answers.testRunner}`).toHaveProperty('test')
      expect(merged.scripts, `${answers.packageManager}/${answers.testRunner}`).toHaveProperty('coverage')
    }
  })

  it('merges every reachable answer set without a package.json conflict', async () => {
    // The merge throws on conflict by design, so this asserts the SHIPPED combinations are all
    // conflict-free — the check that would otherwise only fire when an operator ran the generator.
    const { mergePackageJsonFragments } = await import('./module-contract.js')

    for (const answers of REACHABLE_ANSWERS) {
      const fullAnswers = toFullAnswers(answers)
      const fragments = PROJECT_MODULES.filter((projectModule) => projectModule.isSelected(fullAnswers)).map(
        (projectModule) => ({
          moduleName: projectModule.name,
          fragment: projectModule.packageJsonFragment(fullAnswers),
        }),
      )

      expect(() => mergePackageJsonFragments(fragments)).not.toThrow()
    }
  })
})

describe('module rendered templates', () => {
  it('has every declared template file actually present on disk', async () => {
    // Same reasoning as the documentation check below: a declaration and a file are separate things, and
    // a module claiming a template the generator cannot find fails at generation time, for the operator.
    for (const projectModule of PROJECT_MODULES) {
      for (const answers of REACHABLE_ANSWERS) {
        const templates = projectModule.renderedTemplates?.(toFullAnswers(answers)) ?? []
        for (const template of templates) {
          await expect(
            access(path.join(FACTORY_ROOT, template.templateFile)),
            `${projectModule.name} declares ${template.templateFile} but the file is missing`,
          ).resolves.toBeUndefined()
        }
      }
    }
  })

  it('never has two modules writing the same output path', async () => {
    // A collision means one module silently overwrites the other's rendered file, with the winner
    // decided by registry order.
    for (const answers of REACHABLE_ANSWERS) {
      const fullAnswers = toFullAnswers(answers)
      const outputPaths = PROJECT_MODULES.filter((projectModule) => projectModule.isSelected(fullAnswers)).flatMap(
        (projectModule) =>
          (projectModule.renderedTemplates?.(fullAnswers) ?? []).map((template) => template.outputPath),
      )

      expect(new Set(outputPaths).size, `${answers.packageManager}/${answers.testRunner}`).toBe(outputPaths.length)
    }
  })

  it('merges template data for every reachable answer set without a conflict', async () => {
    const { mergeTemplateData } = await import('./module-contract.js')

    for (const answers of REACHABLE_ANSWERS) {
      const fullAnswers = toFullAnswers(answers)
      const contributions = PROJECT_MODULES.filter((projectModule) => projectModule.isSelected(fullAnswers)).map(
        (projectModule) => ({
          moduleName: projectModule.name,
          data: projectModule.templateData?.(fullAnswers) ?? {},
        }),
      )

      expect(() => mergeTemplateData(contributions)).not.toThrow()
    }
  })

  it('supplies every flag the templates branch on', async () => {
    // The failure this prevents is quiet: a missing flag is falsy in Handlebars, so a template silently
    // renders its `{{else}}` branch instead of erroring. Dropping `usesVitest` would make every project
    // document itself as a bun-test project.
    const { mergeTemplateData } = await import('./module-contract.js')
    const REQUIRED_FLAGS = [
      'isBunRuntime',
      'runCommand',
      'installCommand',
      'ciInstallCommand',
      'execCommand',
      'typescriptRunner',
      'committedLockfile',
      'ignoredLockfiles',
      'usesVitest',
    ]

    for (const answers of REACHABLE_ANSWERS) {
      const fullAnswers = toFullAnswers(answers)
      const merged = mergeTemplateData(
        PROJECT_MODULES.filter((projectModule) => projectModule.isSelected(fullAnswers)).map((projectModule) => ({
          moduleName: projectModule.name,
          data: projectModule.templateData?.(fullAnswers) ?? {},
        })),
      )

      for (const flag of REQUIRED_FLAGS) {
        expect(flag in merged, `${flag} unset for ${answers.packageManager}/${answers.testRunner}`).toBe(true)
      }
    }
  })
})

describe('module documentation', () => {
  it('requires every module to declare a document under docs/', () => {
    for (const projectModule of PROJECT_MODULES) {
      expect(projectModule.documentation.path.startsWith('docs/')).toBe(true)
      expect(projectModule.documentation.path.endsWith('.md')).toBe(true)
      expect(projectModule.documentation.title.length).toBeGreaterThan(0)
      expect(projectModule.documentation.summary.length).toBeGreaterThan(0)
    }
  })

  it('gives every module a distinct document path', () => {
    // Two modules pointing at one path means the later verbatim copy silently overwrites the earlier,
    // and one module ships undocumented while appearing documented in the index.
    const paths = PROJECT_MODULES.map((projectModule) => projectModule.documentation.path)

    expect(new Set(paths).size).toBe(paths.length)
  })

  it('has the declared document actually present in the module source tree', async () => {
    // The declaration and the file are separate things; without this check a module can claim a
    // document that the copy channel never delivers, and the docs index links to a 404.
    for (const projectModule of PROJECT_MODULES) {
      const expectedPath = path.join(
        FACTORY_ROOT,
        'modules',
        projectModule.name,
        'source',
        projectModule.documentation.path,
      )

      await expect(
        access(expectedPath),
        `${projectModule.name} declares ${projectModule.documentation.path} but the file is missing`,
      ).resolves.toBeUndefined()
    }
  })
})
