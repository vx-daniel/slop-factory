import { describe, expect, it } from 'vitest'
import nodePlop from 'node-plop'
import { PACKAGE_MANAGERS, TEST_RUNNERS } from '../modules/module-contract.js'
import { resolvePlopfilePath } from '../plopfile-path.js'

/**
 * Asserts the PROMPTS and the modules cannot drift apart.
 *
 * This suite exists because of a real, silent failure: the runtime prompt was deleted during a refactor
 * and nothing noticed. `generation.test.ts` supplies answers directly to `runActions`, so it never sees
 * the prompt list at all — every one of its 87 assertions passed against a generator that could no
 * longer ask which runtime to use. The resulting project had no `engines`, no tsx, and a `check:all`
 * that died on `Cannot find package 'tsx'`.
 *
 * The lesson generalises: a module is selected by matching an ANSWER, so a prompt that stops producing
 * that answer disables the module silently. Anything that asserts on modules while bypassing prompts
 * cannot catch it — only reading the prompt list can.
 */

const REQUIRED_PROMPT_NAMES = [
  'projectName',
  'projectPath',
  'packageManager',
  'testRunner',
  'enableFeatures',
]

interface PromptDescriptor {
  readonly name?: string
  readonly type?: string
  readonly choices?: ReadonlyArray<{ value?: unknown }>
}

async function loadGeneratorPrompts(): Promise<readonly PromptDescriptor[]> {
  const plop = await nodePlop(resolvePlopfilePath())
  const generator = plop.getGenerator('generate')
  return generator.prompts as readonly PromptDescriptor[]
}

describe('generator prompts', () => {
  it('asks for every answer the modules select on', async () => {
    const promptNames = (await loadGeneratorPrompts()).map((prompt) => prompt.name)

    for (const requiredName of REQUIRED_PROMPT_NAMES) {
      expect(promptNames, `no prompt produces the "${requiredName}" answer`).toContain(requiredName)
    }
  })

  it('offers exactly the package managers the contract declares', async () => {
    // A choice value that drifts from PACKAGE_MANAGERS selects no manager module at all, because
    // selection is an equality test. The answer would be a valid-looking string that matches nothing.
    const prompts = await loadGeneratorPrompts()
    const managerPrompt = prompts.find((prompt) => prompt.name === 'packageManager')

    expect(managerPrompt, 'the packageManager prompt is missing').toBeDefined()
    const offeredValues = (managerPrompt?.choices ?? []).map((choice) => choice.value)

    expect(offeredValues.slice().sort()).toEqual([...PACKAGE_MANAGERS].sort())
  })

  it('offers exactly the test runners the contract declares', async () => {
    const prompts = await loadGeneratorPrompts()
    const testRunnerPrompt = prompts.find((prompt) => prompt.name === 'testRunner')

    expect(testRunnerPrompt, 'the testRunner prompt is missing').toBeDefined()
    const offeredValues = (testRunnerPrompt?.choices ?? []).map((choice) => choice.value)

    expect(offeredValues.slice().sort()).toEqual([...TEST_RUNNERS].sort())
  })

  it('defaults the destination to the current directory', async () => {
    // The most likely keystroke on this prompt is a bare Enter, so its default decides where projects
    // land by default. An earlier directory-browser prompt defaulted to the PARENT of the working
    // directory (and, with its parent entry disabled, to `node_modules`) — measured, both times.
    const prompts = await loadGeneratorPrompts()
    const pathPrompt = prompts.find((prompt) => prompt.name === 'projectPath') as
      | (PromptDescriptor & { default?: unknown })
      | undefined

    expect(pathPrompt?.default, 'the destination prompt must default to the working directory').toBe(
      '.',
    )
  })

  it('does not yet offer the project-structure question', async () => {
    // Asserts an ABSENCE on purpose, and it is meant to fail the day the monorepo layout is finished.
    //
    // The plumbing that resolves the package root and writes the `workspaces` field is in place, but the
    // per-module template changes are not: a generated monorepo's tsconfig `paths` and test-discovery
    // globs still assume `single`. Offering the choice now would produce a project that installs and
    // typechecks and is quietly wrong, which #1 says is worse than not offering it.
    //
    // So this is the tripwire. Adding the prompt without the template changes fails here; adding both
    // together means deleting this test and asserting the choices against `PROJECT_STRUCTURES` instead,
    // the way the manager and runner prompts already are.
    const promptNames = (await loadGeneratorPrompts()).map((prompt) => prompt.name)

    expect(
      promptNames,
      'a projectStructure prompt exists — if the monorepo template changes have landed, replace this ' +
        'test with one asserting its choices match PROJECT_STRUCTURES',
    ).not.toContain('projectStructure')
  })

  it('asks the test-runner question only for the bun manager', async () => {
    // For npm and pnpm there is exactly one possible answer, and a question with one answer is noise.
    const prompts = await loadGeneratorPrompts()
    const testRunnerPrompt = prompts.find((prompt) => prompt.name === 'testRunner') as
      | (PromptDescriptor & { when?: (answers: Record<string, unknown>) => boolean })
      | undefined

    expect(typeof testRunnerPrompt?.when).toBe('function')
    expect(testRunnerPrompt?.when?.({ packageManager: 'bun' })).toBe(true)
    expect(testRunnerPrompt?.when?.({ packageManager: 'npm' })).toBe(false)
    expect(testRunnerPrompt?.when?.({ packageManager: 'pnpm' })).toBe(false)
  })
})
