import { access, constants, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROJECT_MODULES } from '../modules/registry.js'
import { isBunRuntime, type PackageManager, type TestRunner } from '../modules/module-contract.js'
import {
  generateProject,
  isIgnoredByGit,
  isPackageManagerAvailable,
  runCommand,
  shouldKeepGeneratedTrees,
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

/**
 * The install command each manager's CI workflow must use — the frozen form, never a plain install.
 *
 * Used as the DISCRIMINATOR for "did the right workflow ship", in place of checking for a manager's
 * name. Names cannot do that job here: `npm` is a substring of `pnpm`, so asserting a pnpm project's
 * workflow does not mention "npm" fails against its own correct `pnpm install` line. These three
 * commands are pairwise non-substrings, so each one identifies exactly one manager.
 */
const CI_INSTALL_COMMANDS: Readonly<Record<PackageManager, string>> = {
  npm: 'npm ci',
  pnpm: 'pnpm install --frozen-lockfile',
  bun: 'bun install --frozen-lockfile',
}

/** The single lockfile each manager commits. Every other manager's is ignored — see gitignore.hbs. */
const COMMITTED_LOCKFILES: Readonly<Record<PackageManager, string>> = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  bun: 'bun.lock',
}

interface Combination {
  readonly label: string
  readonly packageManager: PackageManager
  readonly testRunner: TestRunner
  readonly enableFeatures: readonly string[]
}

/**
 * Every combination the prompts can produce — eight of them.
 *
 * `bun-test` appears only under the bun manager because the prompt is skipped for npm and pnpm: `bun
 * test` ships with the Bun runtime and has no Node equivalent. That is what keeps this at eight rather
 * than twelve.
 *
 * The "no features" rows matter more than they look: with no config module the project has no source
 * code and no tests, which BOTH runners treat as a failure by default — Vitest needs `passWithNoTests`,
 * and `bun test` has no such flag, which is why the bun-test module ships a real test of its own.
 */
const COMBINATIONS: readonly Combination[] = [
  { label: 'npm + vitest + config', packageManager: 'npm', testRunner: 'vitest', enableFeatures: ['config'] },
  { label: 'npm + vitest + bare', packageManager: 'npm', testRunner: 'vitest', enableFeatures: [] },
  { label: 'pnpm + vitest + config', packageManager: 'pnpm', testRunner: 'vitest', enableFeatures: ['config'] },
  { label: 'pnpm + vitest + bare', packageManager: 'pnpm', testRunner: 'vitest', enableFeatures: [] },
  { label: 'bun + vitest + config', packageManager: 'bun', testRunner: 'vitest', enableFeatures: ['config'] },
  { label: 'bun + vitest + bare', packageManager: 'bun', testRunner: 'vitest', enableFeatures: [] },
  { label: 'bun + bun-test + config', packageManager: 'bun', testRunner: 'bun-test', enableFeatures: ['config'] },
  { label: 'bun + bun-test + bare', packageManager: 'bun', testRunner: 'bun-test', enableFeatures: [] },
]

let workspaceDirectory: string

beforeAll(async () => {
  workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), 'slop-factory-verify-'))
})

afterAll(async () => {
  // Kept when KEEP_GENERATED_TREES is set, so a failure can be inspected rather than re-reproduced.
  if (shouldKeepGeneratedTrees) {
    process.stdout.write(`\nGenerated trees kept at ${workspaceDirectory}\n`)
    return
  }
  await rm(workspaceDirectory, { recursive: true, force: true })
})

describe.each(COMBINATIONS)('$label', (combination) => {
  const { packageManager, testRunner, enableFeatures } = combination
  const hasConfigModule = enableFeatures.includes('config')
  const usesVitest = testRunner === 'vitest'
  const usesBunRuntime = isBunRuntime(packageManager)
  const managerAvailable = isPackageManagerAvailable(packageManager)

  /** The answer object the modules see — used to derive expectations rather than restating them. */
  const answers = { projectName: 'irrelevant', projectPath: '/tmp', packageManager, testRunner, enableFeatures }

  let projectDirectory: string

  // The whole describe block is meaningless without the manager installed, so skip rather than fail —
  // a machine without Bun should report SKIP, not a broken factory.
  beforeAll(async () => {
    if (!managerAvailable) {
      return
    }
    projectDirectory = await generateProject({
      projectName: `verify-${packageManager}-${testRunner}-${hasConfigModule ? 'config' : 'bare'}`,
      workspaceDirectory,
      packageManager,
      testRunner,
      enableFeatures,
    })

    // Initialised BEFORE install so `prepare` can wire core.hooksPath. Without a git tree `prepare`
    // prints "fatal: not in a git directory" and passes anyway (by design, `|| true`), which means an
    // un-inited tree silently skips the very thing that step exists to do.
    // Setup failures THROW rather than assert, for the same reason as in packaging.test.ts: a git or
    // install failure means the tests below never ran, which is a different thing from any of them
    // being false.
    const gitInit = runCommand({
      command: 'git',
      commandArguments: ['init', '--quiet', '.'],
      workingDirectory: projectDirectory,
    })
    if (!gitInit.succeeded) {
      throw new Error(`git init failed in ${projectDirectory}:\n${gitInit.output}`)
    }

    const install = runCommand({
      command: packageManager,
      commandArguments: ['install'],
      workingDirectory: projectDirectory,
    })
    if (!install.succeeded) {
      throw new Error(`${packageManager} install failed in ${projectDirectory}:\n${install.output}`)
    }
  })

  it.skipIf(!managerAvailable)('passes its own gate', () => {
    const gate = runCommand({
      command: packageManager,
      commandArguments: ['run', 'check:all'],
      workingDirectory: projectDirectory,
    })

    expect(gate.succeeded, gate.output).toBe(true)
  })

  it.skipIf(!managerAvailable)('passes its own coverage floor', () => {
    const coverage = runCommand({
      command: packageManager,
      commandArguments: ['run', 'coverage'],
      workingDirectory: projectDirectory,
    })

    expect(coverage.succeeded, coverage.output).toBe(true)
  })

  it.skipIf(!managerAvailable || !usesVitest)(
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

  it.skipIf(!managerAvailable || usesVitest)(
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

  it.skipIf(!managerAvailable)('ships exactly one test runner and no leftovers', async () => {
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

  it.skipIf(!managerAvailable)('ships the CI workflow for its own package manager', async () => {
    // ci.yml is ONE rendered template shared by all three managers, differing only in the setup steps
    // and the install command. Interpolating the wrong manager's vocabulary is therefore a live risk,
    // and one that only shows up when CI runs — hence asserting it here.
    const ciWorkflow = await readFile(
      path.join(projectDirectory, '.github', 'workflows', 'ci.yml'),
      'utf8',
    )
    // Only the `run:` lines, because the comments legitimately NAME the other package managers when
    // explaining the difference between them. Asserting against the whole file made this test fail on
    // its own documentation.
    const executedCommands = commandsExecutedBy(ciWorkflow)

    expectOnlyThisManagersInstall({ executedCommands, packageManager, workflowName: 'ci.yml' })
  })

  it.skipIf(!managerAvailable)(
    'ships coverage-main.yml only where its package manager is correct',
    async () => {
      // This workflow is Vitest-specific (it reads the `json-summary` reporter's output, which `bun
      // test` does not produce) and currently ships only for the Node managers — issue #3. Its install
      // steps ARE interpolated, so the failure to guard against is no longer "npm ci under Bun" but the
      // subtler one: pnpm's variant must use `pnpm exec`, and must place pnpm/action-setup before
      // setup-node or the cache step cannot find the store.
      const workflowPath = path.join(
        projectDirectory,
        '.github',
        'workflows',
        'coverage-main.yml',
      )
      const workflowExists = await access(workflowPath)
        .then(() => true)
        .catch(() => false)

      expect(workflowExists, 'coverage-main.yml should ship only for the Node managers').toBe(
        !usesBunRuntime,
      )
      if (!workflowExists) {
        return
      }

      const workflow = await readFile(workflowPath, 'utf8')
      expectOnlyThisManagersInstall({
        executedCommands: commandsExecutedBy(workflow),
        packageManager,
        workflowName: 'coverage-main.yml',
      })
    },
  )

  it.skipIf(!managerAvailable)('ships an executable pre-commit hook wired via core.hooksPath', async () => {
    // The executable bit is load-bearing and silently lost by any copy that does not preserve modes:
    // git simply declines to run a non-executable hook, so the pre-commit gate goes quietly absent.
    const hookPath = path.join(projectDirectory, '.githooks', 'pre-commit')
    await expect(access(hookPath, constants.X_OK)).resolves.toBeUndefined()

    const hooksPath = runCommand({
      command: 'git',
      commandArguments: ['config', 'core.hooksPath'],
      workingDirectory: projectDirectory,
    })
    expect(hooksPath.output.trim()).toBe('.githooks')
  })

  it.skipIf(!managerAvailable)('commits exactly one lockfile', () => {
    // Two committed lockfiles for one package.json resolve independently and drift, and nobody notices
    // until a version differs between a teammate's install and CI. Asserted for all three managers
    // rather than just this one, because the bug this catches is an EXTRA lockfile being committable,
    // which an assertion about only the expected file cannot see.
    for (const [manager, lockfile] of Object.entries(COMMITTED_LOCKFILES)) {
      const shouldBeCommitted = manager === packageManager

      expect(
        isIgnoredByGit({ filePath: lockfile, workingDirectory: projectDirectory }),
        shouldBeCommitted
          ? `${lockfile} must be committed under ${packageManager}`
          : `${lockfile} belongs to ${manager} and must be ignored under ${packageManager}`,
      ).toBe(!shouldBeCommitted)
    }
  })

  it.skipIf(!managerAvailable)('ignores secrets and build output, but not the examples', () => {
    for (const filePath of ['.env', 'coverage/index.html', 'dist/bundle.js']) {
      expect(
        isIgnoredByGit({ filePath, workingDirectory: projectDirectory }),
        `${filePath} should be ignored`,
      ).toBe(true)
    }
  })

  it.skipIf(!managerAvailable || !hasConfigModule)(
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

  it.skipIf(!managerAvailable)('preserves GitHub Actions expressions verbatim', async () => {
    // The single most important assertion about the rendered channel. ci.yml is now a TEMPLATE, so
    // `${{ github.ref }}` only survives because the template escapes it as `$\{{ github.ref }}`.
    // Without the escape Handlebars resolves `{{ github.ref }}` against the answers, finds nothing,
    // and leaves a bare `$` — a workflow that installs and typechecks fine and fails only in CI.
    const workflowPath = path.join(projectDirectory, '.github', 'workflows', 'ci.yml')

    await expect(readFile(workflowPath, 'utf8')).resolves.toContain('${{ github.ref }}')
  })

  it.skipIf(!managerAvailable)('ships a document for every selected module, plus an index', async () => {
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

  it.skipIf(!managerAvailable)('ships no document for an unselected module', async () => {
    const unselectedModules = PROJECT_MODULES.filter(
      (projectModule) => !projectModule.isSelected(answers),
    )

    for (const projectModule of unselectedModules) {
      const documentPath = path.join(projectDirectory, projectModule.documentation.path)

      // ENOENT specifically, not any error. A bare `toThrow()` would also pass if `access` rejected for
      // an unrelated reason (EACCES, ENOTDIR), reporting "correctly absent" for a file that is present
      // but unreadable.
      await expect(
        access(documentPath),
        `${projectModule.name} is not selected but its document was copied`,
      ).rejects.toThrow(/ENOENT/)
    }
  })

  it.skipIf(!managerAvailable)('renders docs as markdown, not HTML-escaped text', async () => {
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

  it.skipIf(!managerAvailable)('leaves no unrendered template markers in generated docs', async () => {
    for (const documentName of ['CLAUDE.md', 'README.md', '.gitignore']) {
      const contents = await readFile(path.join(projectDirectory, documentName), 'utf8')

      expect(contents, `${documentName} has an unresolved Handlebars expression`).not.toMatch(
        /\{\{|\}\}/,
      )
    }
  })
})

/**
 * The `run:` lines of a workflow, joined.
 *
 * Comments are excluded deliberately: these workflows legitimately NAME the other package managers when
 * explaining why their setup differs. Asserting against the whole file made the workflow tests fail on
 * their own documentation.
 */
function commandsExecutedBy(workflowContents: string): string {
  return workflowContents
    .split('\n')
    .filter((line) => /^\s*run:/.test(line))
    .join('\n')
}

/**
 * Asserts a workflow installs with the selected manager's command and with neither other manager's.
 *
 * Both halves are needed. Checking only for the expected command would pass a workflow that installs
 * twice; checking only for the absence of the others would pass one that never installs at all.
 */
function expectOnlyThisManagersInstall(options: {
  readonly executedCommands: string
  readonly packageManager: PackageManager
  readonly workflowName: string
}): void {
  const { executedCommands, packageManager, workflowName } = options

  expect(executedCommands, `${workflowName} has the wrong install command`).toContain(
    CI_INSTALL_COMMANDS[packageManager],
  )

  for (const [otherManager, installCommand] of Object.entries(CI_INSTALL_COMMANDS)) {
    if (otherManager === packageManager) {
      continue
    }
    expect(
      executedCommands,
      `${workflowName} installs with ${otherManager} as well as ${packageManager}`,
    ).not.toContain(installCommand)
  }
}
