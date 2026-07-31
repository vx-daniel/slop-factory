import nodePlop from 'node-plop'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FIRST_PACKAGE_NAME,
  PACKAGE_MANAGERS,
  PROJECT_STRUCTURES,
  TEST_RUNNERS,
} from '../modules/module-contract.js'
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
  'projectStructure',
  'packageNames',
  'packageManager',
  'testRunner',
  'enableFeatures',
]

interface PromptDescriptor {
  readonly name?: string
  readonly type?: string
  readonly choices?: ReadonlyArray<{ value?: unknown }>
}

/** The fields the package-names prompt is asserted on, beyond the ones every prompt has. */
interface PackageNamesPromptDescriptor extends PromptDescriptor {
  readonly when?: (answers: Record<string, unknown>) => boolean
  readonly default?: unknown
  readonly validate?: (rawAnswer: string) => true | string
}

async function loadGeneratorPrompts(): Promise<readonly PromptDescriptor[]> {
  const plop = await nodePlop(resolvePlopfilePath())
  const generator = plop.getGenerator('generate')
  return generator.prompts as readonly PromptDescriptor[]
}

/**
 * The package-names prompt, read through the generator rather than imported.
 *
 * Its `validate` function is not exported from `plopfile.ts` and deliberately stays that way: reaching the
 * validator only through the prompt list is what makes these assertions fail when the prompt is renamed or
 * dropped, which is the failure this whole suite exists to catch.
 */
async function findPackageNamesPrompt(): Promise<PackageNamesPromptDescriptor | undefined> {
  const prompts = await loadGeneratorPrompts()
  return prompts.find((prompt) => prompt.name === 'packageNames') as PackageNamesPromptDescriptor | undefined
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

    expect(pathPrompt?.default, 'the destination prompt must default to the working directory').toBe('.')
  })

  it('offers exactly the project structures the contract declares', async () => {
    // Replaces an absence-assertion that guarded this prompt while the monorepo templates were being
    // built: exposing the choice before the layout worked would have generated projects that install and
    // typecheck and are quietly wrong. The templates have landed, so the guard becomes a real check.
    const prompts = await loadGeneratorPrompts()
    const structurePrompt = prompts.find((prompt) => prompt.name === 'projectStructure')

    expect(structurePrompt, 'the projectStructure prompt is missing').toBeDefined()
    const offeredValues = (structurePrompt?.choices ?? []).map((choice) => choice.value)

    expect(offeredValues.slice().sort()).toEqual([...PROJECT_STRUCTURES].sort())
  })

  it('asks for the package names only for a workspace', async () => {
    // Under `single` there is no packages directory for the answer to name, so the question has exactly
    // one meaningless answer.
    const packageNamesPrompt = await findPackageNamesPrompt()

    expect(packageNamesPrompt, 'the packageNames prompt is missing').toBeDefined()
    expect(typeof packageNamesPrompt?.when).toBe('function')
    expect(packageNamesPrompt?.when?.({ projectStructure: 'monorepo' })).toBe(true)
    expect(packageNamesPrompt?.when?.({ projectStructure: 'single' })).toBe(false)
    expect(packageNamesPrompt?.default).toBe(DEFAULT_FIRST_PACKAGE_NAME)
  })

  it('accepts several comma-separated package names', async () => {
    // The prompt is the ONLY place an interactive operator can ask for more than one package, so a
    // validator that declined a list would silently cap every generated workspace at one — with the
    // generator itself perfectly able to produce several.
    const validate = (await findPackageNamesPrompt())?.validate

    expect(typeof validate).toBe('function')
    expect(validate?.('core, api, worker')).toBe(true)
    // Trailing and doubled separators are things people type. They must be dropped rather than becoming
    // an empty path segment — `packages//package.json`.
    expect(validate?.('core,,api,')).toBe(true)
  })

  it('declines names that would not be a single directory under packages/', async () => {
    const validate = (await findPackageNamesPrompt())?.validate

    // A path separator escapes the workspace directory; a dot-name resolves somewhere else entirely.
    expect(validate?.('core,../etc')).toMatch(/single directory name/)
    expect(validate?.('core,.hidden')).toMatch(/dot/)
    // Rejected rather than deduplicated: two identical tsconfig `paths` keys are silently last-one-wins,
    // so a generated workspace would have one alias where the operator asked for two packages.
    expect(validate?.('core,api,core')).toMatch(/named twice/)
    // Every separator and no name at all is not "zero packages" — it is an answer that cannot be built.
    expect(validate?.(' , ')).toMatch(/at least one/)
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
