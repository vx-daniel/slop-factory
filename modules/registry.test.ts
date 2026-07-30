import { access } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_MODULES } from './registry.js'

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')

/** Both runtime answers, so selection can be exercised without hardcoding a combination per test. */
const RUNTIMES = ['node', 'bun'] as const

/** The mutually-exclusive test-runner modules. */
const TEST_RUNNER_MODULES = ['vitest', 'bun-test'] as const

/**
 * Every combination the prompts can actually produce.
 *
 * `bun-test` appears only with the bun runtime, because the prompt is skipped under Node and
 * `toProjectAnswers` forces `vitest` there — asserting a node + bun-test combination would be
 * asserting behaviour for an answer set the generator cannot produce.
 */
const REACHABLE_ANSWERS = [
  { projectRuntime: 'node', testRunner: 'vitest', enableFeatures: [] },
  { projectRuntime: 'node', testRunner: 'vitest', enableFeatures: ['config'] },
  { projectRuntime: 'bun', testRunner: 'vitest', enableFeatures: [] },
  { projectRuntime: 'bun', testRunner: 'vitest', enableFeatures: ['config'] },
  { projectRuntime: 'bun', testRunner: 'bun-test', enableFeatures: [] },
  { projectRuntime: 'bun', testRunner: 'bun-test', enableFeatures: ['config'] },
] as const

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

  it('selects exactly one runtime module for every reachable answer set', () => {
    // Two selected runtimes would contribute conflicting `engines`; zero would leave the project with
    // no declared runtime at all. Both are silent failures without this check.
    for (const answers of REACHABLE_ANSWERS) {
      const selectedRuntimeModules = PROJECT_MODULES.filter(
        (projectModule) =>
          projectModule.isSelected({ projectName: 'example', projectPath: '/tmp', ...answers }) &&
          RUNTIMES.some((runtimeName) => runtimeName === projectModule.name),
      )

      expect(selectedRuntimeModules.map((projectModule) => projectModule.name)).toEqual([
        answers.projectRuntime,
      ])
    }
  })

  it('selects exactly one test-runner module for every reachable answer set', () => {
    // Two selected test runners would conflict on the `test` script — which the merge would throw on,
    // but at generation time rather than here.
    for (const answers of REACHABLE_ANSWERS) {
      const selectedTestRunnerModules = PROJECT_MODULES.filter(
        (projectModule) =>
          projectModule.isSelected({ projectName: 'example', projectPath: '/tmp', ...answers }) &&
          TEST_RUNNER_MODULES.some((moduleName) => moduleName === projectModule.name),
      )

      expect(selectedTestRunnerModules.map((projectModule) => projectModule.name)).toEqual([
        answers.testRunner,
      ])
    }
  })

  it('always provides a `test` and a `coverage` script, whichever runner is chosen', async () => {
    // `scripts/gate.ts` runs `test` and the CI workflow runs `coverage`. A combination that omits
    // either produces a project whose own gate or CI fails on a missing script.
    const { mergePackageJsonFragments } = await import('./module-contract.js')

    for (const answers of REACHABLE_ANSWERS) {
      const fullAnswers = { projectName: 'example', projectPath: '/tmp', ...answers }
      const merged = mergePackageJsonFragments(
        PROJECT_MODULES.filter((projectModule) => projectModule.isSelected(fullAnswers)).map(
          (projectModule) => ({
            moduleName: projectModule.name,
            fragment: projectModule.packageJsonFragment(fullAnswers),
          }),
        ),
      )

      expect(merged.scripts, `${answers.projectRuntime}/${answers.testRunner}`).toHaveProperty('test')
      expect(merged.scripts, `${answers.projectRuntime}/${answers.testRunner}`).toHaveProperty(
        'coverage',
      )
    }
  })

  it('merges every reachable answer set without a package.json conflict', async () => {
    // The merge throws on conflict by design, so this asserts the SHIPPED combinations are all
    // conflict-free — the check that would otherwise only fire when an operator ran the generator.
    const { mergePackageJsonFragments } = await import('./module-contract.js')

    for (const answers of REACHABLE_ANSWERS) {
      const fullAnswers = { projectName: 'example', projectPath: '/tmp', ...answers }
      const fragments = PROJECT_MODULES.filter((projectModule) =>
        projectModule.isSelected(fullAnswers),
      ).map((projectModule) => ({
        moduleName: projectModule.name,
        fragment: projectModule.packageJsonFragment(fullAnswers),
      }))

      expect(() => mergePackageJsonFragments(fragments)).not.toThrow()
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
