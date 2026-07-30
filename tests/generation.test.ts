import { access, constants, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROJECT_MODULES } from '../modules/registry.js'
import type { ProjectRuntime, TestRunner } from '../modules/module-contract.js'
import {
  generateProject,
  isIgnoredByGit,
  isRuntimeAvailable,
  runCommand,
} from './generate-project.js'

/**
 * End-to-end verification: generate a real project, install it, run its own gate.
 *
 * This is the only thing that can catch the two failures that matter most, both of which install and
 * typecheck cleanly and so are invisible to anything cheaper:
 *
 *   1. A package.json fragment merge producing a project whose dependencies do not satisfy its own
 *      scripts.
 *   2. A file rendered when it should have been copied verbatim. Handlebars and GitHub Actions both
 *      claim `{{ }}`, so a rendered workflow loses its expressions and fails only in CI.
 *
 * Each combination gets a real git tree, because three of the behaviours asserted below do not exist
 * without one: the `prepare` hook wiring, the `.gitignore` rules, and the commit SHA in COVERAGE.md.
 */

interface Combination {
  readonly label: string
  readonly projectRuntime: ProjectRuntime
  readonly testRunner: TestRunner
  readonly enableFeatures: readonly string[]
}

/**
 * Every combination the prompts can produce.
 *
 * `bun-test` appears only under the Bun runtime because the prompt is skipped under Node. The
 * "no features" rows matter more than they look: with no config module the project has no source code
 * and no tests, which BOTH runners treat as a failure by default — Vitest needs `passWithNoTests`, and
 * `bun test` has no such flag, which is why the bun-test module ships a real test of its own.
 */
const COMBINATIONS: readonly Combination[] = [
  { label: 'node + vitest + config', projectRuntime: 'node', testRunner: 'vitest', enableFeatures: ['config'] },
  { label: 'node + vitest + bare', projectRuntime: 'node', testRunner: 'vitest', enableFeatures: [] },
  { label: 'bun + vitest + config', projectRuntime: 'bun', testRunner: 'vitest', enableFeatures: ['config'] },
  { label: 'bun + vitest + bare', projectRuntime: 'bun', testRunner: 'vitest', enableFeatures: [] },
  { label: 'bun + bun-test + config', projectRuntime: 'bun', testRunner: 'bun-test', enableFeatures: ['config'] },
  { label: 'bun + bun-test + bare', projectRuntime: 'bun', testRunner: 'bun-test', enableFeatures: [] },
]

let workspaceDirectory: string

beforeAll(async () => {
  workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), 'slop-factory-verify-'))
})

afterAll(async () => {
  // Kept when KEEP_GENERATED_TREES is set, so a failure can be inspected rather than re-reproduced.
  if (process.env.KEEP_GENERATED_TREES === undefined) {
    await rm(workspaceDirectory, { recursive: true, force: true })
  } else {
    process.stdout.write(`\nGenerated trees kept at ${workspaceDirectory}\n`)
  }
})

describe.each(COMBINATIONS)('$label', (combination) => {
  const { projectRuntime, testRunner, enableFeatures } = combination
  const hasConfigModule = enableFeatures.includes('config')
  const usesVitest = testRunner === 'vitest'
  const packageManager = projectRuntime === 'bun' ? 'bun' : 'npm'
  const runtimeAvailable = isRuntimeAvailable(projectRuntime)

  /** The answer object the modules see — used to derive expectations rather than restating them. */
  const answers = { projectName: 'irrelevant', projectPath: '/tmp', projectRuntime, testRunner, enableFeatures }

  let projectDirectory: string

  // The whole describe block is meaningless without the runtime installed, so skip rather than fail —
  // a machine without Bun should report SKIP, not a broken factory.
  beforeAll(async () => {
    if (!runtimeAvailable) {
      return
    }
    projectDirectory = await generateProject({
      projectName: `verify-${projectRuntime}-${testRunner}-${hasConfigModule ? 'config' : 'bare'}`,
      workspaceDirectory,
      projectRuntime,
      testRunner,
      enableFeatures,
    })

    // Initialised BEFORE install so `prepare` can wire core.hooksPath. Without a git tree `prepare`
    // prints "fatal: not in a git directory" and passes anyway (by design, `|| true`), which means an
    // un-inited tree silently skips the very thing that step exists to do.
    const gitInit = runCommand({
      command: 'git',
      commandArguments: ['init', '--quiet', '.'],
      workingDirectory: projectDirectory,
    })
    expect(gitInit.succeeded, gitInit.output).toBe(true)

    const install = runCommand({
      command: packageManager,
      commandArguments: ['install'],
      workingDirectory: projectDirectory,
    })
    expect(install.succeeded, install.output).toBe(true)
  })

  it.skipIf(!runtimeAvailable)('passes its own gate', () => {
    const gate = runCommand({
      command: packageManager,
      commandArguments: ['run', 'check:all'],
      workingDirectory: projectDirectory,
    })

    expect(gate.succeeded, gate.output).toBe(true)
  })

  it.skipIf(!runtimeAvailable)('passes its own coverage floor', () => {
    const coverage = runCommand({
      command: packageManager,
      commandArguments: ['run', 'coverage'],
      workingDirectory: projectDirectory,
    })

    expect(coverage.succeeded, coverage.output).toBe(true)
  })

  it.skipIf(!runtimeAvailable || !usesVitest)(
    'injects coverage totals into the README marker block',
    async () => {
      // `coverage:readme` is a separate script from `coverage` and would otherwise never run. The
      // README is a rendered template, so its marker block could drift from what the script searches
      // for — making the script broken on day one in every generated project.
      const injection = runCommand({
        command: packageManager,
        commandArguments: ['run', 'coverage:readme'],
        workingDirectory: projectDirectory,
      })
      expect(injection.succeeded, injection.output).toBe(true)

      const readme = await readFile(path.join(projectDirectory, 'README.md'), 'utf8')
      expect(readme).toContain('| Metric | % | Covered/Total |')
    },
  )

  it.skipIf(!runtimeAvailable || usesVitest)(
    'puts the coverage floor in bunfig.toml, guarded by its own test',
    async () => {
      // Under `bun test` the floor lives in a file nothing else reads, so both the config and the test
      // that guards it must be present — without the guard, deleting the threshold is silent.
      const bunfig = await readFile(path.join(projectDirectory, 'bunfig.toml'), 'utf8')
      expect(bunfig).toMatch(/coverageThreshold\s*=\s*0\.85/)
      expect(bunfig).toMatch(/coverage\s*=\s*true/)

      await expect(
        access(path.join(projectDirectory, 'test', 'coverage-floor.test.ts')),
      ).resolves.toBeUndefined()
    },
  )

  it.skipIf(!runtimeAvailable)('ships exactly one test runner and no leftovers', async () => {
    // A file from the unselected runner surviving is the failure mode a two-module split invites:
    // the project would carry a vitest.config.ts it never reads, or a bunfig.toml with a dead floor.
    const vitestConfigExists = await access(path.join(projectDirectory, 'vitest.config.ts'))
      .then(() => true)
      .catch(() => false)
    const bunfigExists = await access(path.join(projectDirectory, 'bunfig.toml'))
      .then(() => true)
      .catch(() => false)

    expect({ vitestConfigExists, bunfigExists }).toEqual({
      vitestConfigExists: usesVitest,
      bunfigExists: !usesVitest,
    })
  })

  it.skipIf(!runtimeAvailable)('ships the CI workflow for its own package manager', async () => {
    // ci.yml is duplicated across the runtime modules rather than templated, because it contains
    // ${{ }} expressions. That makes "the wrong one shipped" a live risk worth asserting.
    const ciWorkflow = await readFile(
      path.join(projectDirectory, '.github', 'workflows', 'ci.yml'),
      'utf8',
    )
    // Only the `run:` lines, because the comments legitimately NAME the other package manager when
    // explaining the difference between the two variants. Asserting against the whole file made this
    // test fail on its own documentation.
    const executedCommands = ciWorkflow
      .split('\n')
      .filter((line) => /^\s*run:/.test(line))
      .join('\n')

    const expectedInstall = projectRuntime === 'bun' ? 'bun install --frozen-lockfile' : 'npm ci'
    const forbiddenManager = projectRuntime === 'bun' ? 'npm' : 'bun'

    expect(executedCommands, 'wrong install command').toContain(expectedInstall)
    expect(executedCommands, `${forbiddenManager} leaked into the run steps`).not.toContain(
      forbiddenManager,
    )
  })

  it.skipIf(!runtimeAvailable)(
    'ships coverage-main.yml only where its package manager is correct',
    async () => {
      // This workflow is BOTH Vitest-specific (`npx vitest`) and npm-specific (`npm ci`), so it lives in
      // the node module — node always implies Vitest. Shipping it under Bun would put `npm ci` in a repo
      // whose .gitignore excludes package-lock.json: red on every push to main, and invisible to a suite
      // that never executes workflows.
      const workflowPath = path.join(
        projectDirectory,
        '.github',
        'workflows',
        'coverage-main.yml',
      )
      const workflowExists = await access(workflowPath)
        .then(() => true)
        .catch(() => false)

      expect(workflowExists, 'coverage-main.yml should ship only for the node runtime').toBe(
        projectRuntime === 'node',
      )
      if (!workflowExists) {
        return
      }

      const executedCommands = (await readFile(workflowPath, 'utf8'))
        .split('\n')
        .filter((line) => /^\s*run:/.test(line))
        .join('\n')

      expect(executedCommands).toContain('npm ci')
      expect(executedCommands, 'bun leaked into an npm-only workflow').not.toContain('bun')
    },
  )

  it.skipIf(!runtimeAvailable)('ships an executable pre-commit hook wired via core.hooksPath', () => {
    // The executable bit is load-bearing and silently lost by any copy that does not preserve modes:
    // git simply declines to run a non-executable hook, so the pre-commit gate goes quietly absent.
    const hookPath = path.join(projectDirectory, '.githooks', 'pre-commit')
    expect(access(hookPath, constants.X_OK)).resolves.toBeUndefined()

    const hooksPath = runCommand({
      command: 'git',
      commandArguments: ['config', 'core.hooksPath'],
      workingDirectory: projectDirectory,
    })
    expect(hooksPath.output.trim()).toBe('.githooks')
  })

  it.skipIf(!runtimeAvailable)('commits exactly one lockfile', () => {
    const isBun = projectRuntime === 'bun'

    expect(
      isIgnoredByGit({ filePath: 'bun.lock', workingDirectory: projectDirectory }),
      'bun.lock should be committed only under the bun runtime',
    ).toBe(!isBun)
    expect(
      isIgnoredByGit({ filePath: 'package-lock.json', workingDirectory: projectDirectory }),
      'package-lock.json should be committed only under the node runtime',
    ).toBe(isBun)
  })

  it.skipIf(!runtimeAvailable)('ignores secrets and build output, but not the examples', () => {
    for (const filePath of ['.env', 'coverage/index.html', 'dist/bundle.js']) {
      expect(
        isIgnoredByGit({ filePath, workingDirectory: projectDirectory }),
        `${filePath} should be ignored`,
      ).toBe(true)
    }
  })

  it.skipIf(!runtimeAvailable || !hasConfigModule)(
    'commits config defaults while ignoring local overrides',
    () => {
      expect(
        isIgnoredByGit({ filePath: 'config.defaults.toml', workingDirectory: projectDirectory }),
      ).toBe(false)
      expect(
        isIgnoredByGit({ filePath: 'config.local.toml', workingDirectory: projectDirectory }),
      ).toBe(true)
      expect(isIgnoredByGit({ filePath: '.env.example', workingDirectory: projectDirectory })).toBe(
        false,
      )
    },
  )

  it.skipIf(!runtimeAvailable)('preserves GitHub Actions expressions verbatim', () => {
    // The single most important assertion about the copy channel. If `source/` were ever rendered,
    // `{{ github.ref }}` would resolve against the answers, find nothing, and leave a bare `$`.
    const workflowPath = path.join(projectDirectory, '.github', 'workflows', 'ci.yml')

    expect(readFile(workflowPath, 'utf8')).resolves.toContain('${{ github.ref }}')
  })

  it.skipIf(!runtimeAvailable)('ships a document for every selected module, plus an index', async () => {
    const selectedModules = PROJECT_MODULES.filter((projectModule) =>
      projectModule.isSelected(answers),
    )

    const indexContents = await readFile(path.join(projectDirectory, 'docs', 'README.md'), 'utf8')

    for (const projectModule of selectedModules) {
      const documentPath = path.join(projectDirectory, projectModule.documentation.path)
      await expect(
        access(documentPath),
        `${projectModule.name} document missing at ${projectModule.documentation.path}`,
      ).resolves.toBeUndefined()

      // The index must LINK to it, not merely mention it — a doc nobody can navigate to is unread.
      expect(indexContents).toContain(`(${path.basename(projectModule.documentation.path)})`)
    }
  })

  it.skipIf(!runtimeAvailable)('ships no document for an unselected module', async () => {
    const unselectedModules = PROJECT_MODULES.filter(
      (projectModule) => !projectModule.isSelected(answers),
    )

    for (const projectModule of unselectedModules) {
      const documentPath = path.join(projectDirectory, projectModule.documentation.path)

      await expect(
        access(documentPath),
        `${projectModule.name} is not selected but its document was copied`,
      ).rejects.toThrow()
    }
  })

  it.skipIf(!runtimeAvailable)('renders docs as markdown, not HTML-escaped text', async () => {
    // Handlebars' double-stache HTML-escapes its output, so a summary containing a backtick or an
    // apostrophe silently becomes `&#x60;` / `&#x27;` in a file that is only ever read as markdown.
    // These are prose templates, so every interpolation must use the triple form.
    for (const documentName of [
      path.join('docs', 'README.md'),
      'CLAUDE.md',
      'README.md',
    ]) {
      const contents = await readFile(path.join(projectDirectory, documentName), 'utf8')

      expect(contents, `${documentName} contains HTML-escaped characters`).not.toMatch(/&#x[0-9a-f]+;/i)
      expect(contents, `${documentName} contains HTML-escaped entities`).not.toMatch(
        /&(amp|quot|lt|gt|#39);/,
      )
    }
  })

  it.skipIf(!runtimeAvailable)('leaves no unrendered template markers in generated docs', async () => {
    for (const documentName of ['CLAUDE.md', 'README.md', '.gitignore']) {
      const contents = await readFile(path.join(projectDirectory, documentName), 'utf8')

      expect(contents, `${documentName} has an unresolved Handlebars expression`).not.toMatch(
        /\{\{|\}\}/,
      )
    }
  })
})
