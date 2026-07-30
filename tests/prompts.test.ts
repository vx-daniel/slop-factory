import { describe, expect, it } from 'vitest'
import nodePlop from 'node-plop'
import { PROJECT_RUNTIMES, TEST_RUNNERS } from '../modules/module-contract.js'
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
  'projectRuntime',
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

  it('offers exactly the runtimes the contract declares', async () => {
    // A choice value that drifts from PROJECT_RUNTIMES selects no runtime module at all, because
    // selection is an equality test. The answer would be a valid-looking string that matches nothing.
    const prompts = await loadGeneratorPrompts()
    const runtimePrompt = prompts.find((prompt) => prompt.name === 'projectRuntime')

    expect(runtimePrompt, 'the projectRuntime prompt is missing').toBeDefined()
    const offeredValues = (runtimePrompt?.choices ?? []).map((choice) => choice.value)

    expect(offeredValues.slice().sort()).toEqual([...PROJECT_RUNTIMES].sort())
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

  it('asks the test-runner question only under Bun', async () => {
    // Under Node there is exactly one possible answer, and a question with one answer is noise.
    const prompts = await loadGeneratorPrompts()
    const testRunnerPrompt = prompts.find((prompt) => prompt.name === 'testRunner') as
      | (PromptDescriptor & { when?: (answers: Record<string, unknown>) => boolean })
      | undefined

    expect(typeof testRunnerPrompt?.when).toBe('function')
    expect(testRunnerPrompt?.when?.({ projectRuntime: 'bun' })).toBe(true)
    expect(testRunnerPrompt?.when?.({ projectRuntime: 'node' })).toBe(false)
  })
})
