import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import nodePlop from 'node-plop'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

/**
 * One entry in the generator's prompt list, as inquirer describes it.
 *
 * Every field optional because a prompt only carries the ones its type needs: an `input` has a `default`
 * and may have a `validate`, a `list` has `choices`, and only the two conditional prompts have a `when`.
 * The walk below reads whichever are present rather than branching on the type.
 */
interface PromptDescriptor {
  readonly name?: string
  readonly type?: string
  readonly choices?: ReadonlyArray<{ value?: unknown; checked?: boolean }>
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
async function findPackageNamesPrompt(): Promise<PromptDescriptor | undefined> {
  const prompts = await loadGeneratorPrompts()
  return prompts.find((prompt) => prompt.name === 'packageNames')
}

/**
 * What a bare Enter produces for one prompt — a MODEL of inquirer, not a reading of it.
 *
 * inquirer takes `default` for an `input`, the first choice for a `list`, and the `checked` choices for a
 * `checkbox`. Those semantics are stable and long-standing, but they are inquirer's rather than this
 * repository's, so this function is the one place the assumption lives. If a walk below ever disagrees with
 * what the real generator does, suspect this first.
 */
function defaultAnswerFor(prompt: PromptDescriptor): unknown {
  if (prompt.type === 'list') {
    return prompt.choices?.[0]?.value
  }
  if (prompt.type === 'checkbox') {
    return (prompt.choices ?? []).filter((choice) => choice.checked === true).map((choice) => choice.value)
  }
  return prompt.default
}

/**
 * Walks the prompt list the way inquirer does, and reports which questions were asked.
 *
 * THIS IS THE POINT OF THE WHOLE FILE'S SECOND HALF. Every other assertion here checks one prompt in
 * isolation, and a `when` that is right in isolation can still produce a wrong CONVERSATION — most obviously
 * if it reads an answer collected after it, where the value is always `undefined` and the question is
 * therefore always skipped.
 *
 * `suppliedAnswers` overrides the default for the named prompts, which is how a caller steers the walk down
 * a particular path. Everything else takes the bare-Enter answer.
 */
function walkPromptList(
  prompts: readonly PromptDescriptor[],
  suppliedAnswers: Readonly<Record<string, unknown>> = {},
): {
  readonly askedPromptNames: readonly string[]
  readonly answers: Record<string, unknown>
  readonly answerKeysReadByPrompt: ReadonlyMap<string, readonly string[]>
} {
  const answers: Record<string, unknown> = {}
  const askedPromptNames: string[] = []
  const answerKeysReadByPrompt = new Map<string, readonly string[]>()

  for (const prompt of prompts) {
    if (prompt.name === undefined) {
      continue
    }

    if (prompt.when !== undefined) {
      const readKeys: string[] = []
      /**
       * Wraps the REAL answers so far, rather than an empty object.
       *
       * Recording against an empty stand-in looked equivalent and was not: `&&` short-circuits, so a guard
       * written `answers.projectStructure === 'monorepo' && answers.testRunner !== x` never evaluates its
       * second clause when the first is false — and against a stand-in returning `undefined`, the first is
       * ALWAYS false. The read-ahead went unrecorded and the mutation that proves this assertion works
       * passed clean. Reading through to the genuine values keeps the guard on the same code path the
       * generator takes.
       */
      const recordingAnswers = new Proxy(answers, {
        get(target: Record<string, unknown>, propertyKey: string | symbol, receiver: unknown): unknown {
          if (typeof propertyKey === 'string') {
            readKeys.push(propertyKey)
          }
          return Reflect.get(target, propertyKey, receiver)
        },
      })
      const shouldAsk = prompt.when(recordingAnswers)
      answerKeysReadByPrompt.set(prompt.name, readKeys)
      if (!shouldAsk) {
        continue
      }
    }

    askedPromptNames.push(prompt.name)
    answers[prompt.name] = prompt.name in suppliedAnswers ? suppliedAnswers[prompt.name] : defaultAnswerFor(prompt)
  }

  return { askedPromptNames, answers, answerKeysReadByPrompt }
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

/**
 * The conversation as a WHOLE, rather than one prompt at a time.
 *
 * Everything above checks a prompt in isolation, and every one of those can pass while the flow is wrong.
 * The failure that motivates this: a `when` reading an answer collected LATER is `undefined` every time, so
 * it returns a plausible `false` and its question is silently never asked. Both current guards read the
 * prompt immediately before them; nothing enforced that until now.
 *
 * MUTATION EVIDENCE — each of the three fails a different assertion here:
 *   • renaming `projectStructure` to `projectLayout` fails both walks and the ordering guard;
 *   • making `packageNames`' guard read `answers.testRunner` fails the ordering guard by name;
 *   • making `validatePackageNames` reject its own `core` default fails the default-validity assertion.
 *
 * The second one is why the recording Proxy wraps the real answers rather than an empty stand-in. Written
 * the obvious way, that mutation passed clean — `&&` short-circuits, so against a stand-in returning
 * `undefined` the read-ahead was never evaluated and never recorded. The guard looked right and was inert,
 * which is the failure `.claude/rules/asserting-on-file-content.md` was written about, in a new costume.
 */
describe('the shape of the conversation', () => {
  /**
   * The questions an operator is asked when they accept every default.
   *
   * Pinned as an exact ORDERED list rather than a set of memberships. Order is part of the experience —
   * being asked for package names before choosing a layout would be nonsense — and it is also the thing
   * that silently breaks a `when`, since a guard can only read answers already collected.
   */
  const DEFAULT_PATH_QUESTIONS = ['projectName', 'projectPath', 'projectStructure', 'packageManager', 'enableFeatures']

  it('skips the workspace-only question when the defaults are accepted', async () => {
    // The default layout is `single`, which has no packages/ directory for a name to describe. The default
    // manager is npm, which implies Node and therefore Vitest — so the runner question is noise too.
    const { askedPromptNames } = walkPromptList(await loadGeneratorPrompts())

    expect(askedPromptNames).toEqual(DEFAULT_PATH_QUESTIONS)
  })

  it('asks every question for a workspace on bun', async () => {
    // The only combination that reaches all seven: `monorepo` unlocks the package names, `bun` unlocks the
    // runner choice. If a future `when` starts reading a later answer, this is the assertion that notices,
    // because the question it guards drops out of the list.
    const { askedPromptNames } = walkPromptList(await loadGeneratorPrompts(), {
      projectStructure: 'monorepo',
      packageManager: 'bun',
    })

    expect(askedPromptNames).toEqual([
      'projectName',
      'projectPath',
      'projectStructure',
      'packageNames',
      'packageManager',
      'testRunner',
      'enableFeatures',
    ])
  })

  it('never lets a question depend on an answer collected after it', async () => {
    // Both current guards read the prompt immediately before them, which is why they work. Nothing
    // enforced that. Reordering the list, or adding a guard that reads ahead, produces a question that is
    // skipped whenever it should be asked — and the two walks above would still pass if the reordering
    // happened to leave the same set asked on both paths.
    //
    // Checked across BOTH paths, because a guard's later clauses are only reached when its earlier ones
    // pass: `packageNames` reads nothing beyond `projectStructure` until that answer is `monorepo`. One
    // path alone would leave the read-ahead unevaluated and therefore unrecorded.
    //
    // Known limit, stated rather than papered over: a read hidden behind a condition that is false on both
    // paths still escapes. Widening the paths is the fix if that ever matters.
    const prompts = await loadGeneratorPrompts()
    const promptIndexByName = new Map(prompts.map((prompt, promptIndex) => [prompt.name, promptIndex]))

    const walks = [
      walkPromptList(prompts),
      walkPromptList(prompts, { projectStructure: 'monorepo', packageManager: 'bun' }),
    ]

    for (const { answerKeysReadByPrompt } of walks) {
      // Iterated over the PROMPT LIST rather than over the recorded map, so the guarded prompt's position
      // comes from the iteration itself. Looking it up would need a `?? 0` for a case that cannot happen —
      // and a default index of 0 is the worst possible one to invent, because it silently makes every read
      // look like a violation, or none. The one `??` left below is real: a prompt without a `when` records
      // nothing, which is not a failure.
      for (const [guardedPromptIndex, prompt] of prompts.entries()) {
        if (prompt.name === undefined) {
          continue
        }
        const readKeys = answerKeysReadByPrompt.get(prompt.name) ?? []

        for (const readKey of readKeys) {
          // This lookup CAN legitimately miss, and that is a finding rather than a fallback: a guard
          // reading a key no prompt produces — a typo, or an answer that used to exist — is `undefined`
          // forever, exactly the bug this test is here for.
          const readPromptIndex = promptIndexByName.get(readKey)
          expect(
            readPromptIndex !== undefined && readPromptIndex < guardedPromptIndex,
            `the "${prompt.name}" prompt's when() reads "${readKey}", which is not collected before it — ` +
              'it will always be undefined, so the question is always skipped',
          ).toBe(true)
        }
      }
    }
  })
})

describe('every default is an answer its own prompt would accept', () => {
  it('passes each default through its own validator', async () => {
    // A live risk, not a hypothetical: `packageNames` and `projectPath` each carry both a `default` and a
    // `validate`. Tighten a validator without looking at the default and the bare-Enter path — the most
    // common way this generator is used — starts being rejected, while every other test keeps passing
    // because they all supply explicit answers.
    const prompts = await loadGeneratorPrompts()
    const promptsWithBoth = prompts.filter((prompt) => prompt.validate !== undefined && prompt.default !== undefined)

    // Guards the guard: if a refactor moved defaults or validators off these prompts, the loop below would
    // iterate nothing and pass. Two is the current count — `projectPath` and `packageNames`.
    expect(promptsWithBoth.map((prompt) => prompt.name)).toEqual(['projectPath', 'packageNames'])

    for (const prompt of promptsWithBoth) {
      expect(
        prompt.validate?.(String(prompt.default)),
        `the "${prompt.name}" prompt's own default (${JSON.stringify(prompt.default)}) fails its validator`,
      ).toBe(true)
    }
  })
})

describe('the answers a bare-Enter run produces are answers the generator accepts', () => {
  let workspaceDirectory: string

  beforeAll(async () => {
    workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), 'slop-factory-prompts-'))
  })

  afterAll(async () => {
    await rm(workspaceDirectory, { recursive: true, force: true })
  })

  it('generates a project from the walk, without restating a single answer name', async () => {
    // CLOSES THE LOOP THIS FILE'S HEADER DESCRIBES. Every other suite hands `runActions` an answer object
    // it built itself, so all of them would keep passing if a prompt were renamed — that is exactly how a
    // deleted runtime prompt survived 87 green assertions. Here the answer object comes from the PROMPT
    // LIST, so the only thing being tested is whether the names the prompts produce are the names
    // `toProjectAnswers` reads.
    //
    // Two answers have to be supplied. `projectName` has no default because there is no sensible one, and
    // `projectPath` defaults to `.` — which, run from here, means "generate into the factory". Everything
    // else is whatever a bare Enter would give.
    const prompts = await loadGeneratorPrompts()
    const { answers } = walkPromptList(prompts, {
      projectName: 'bare-enter-project',
      projectPath: workspaceDirectory,
    })

    const plop = await nodePlop(resolvePlopfilePath())
    const result = await plop.getGenerator('generate').runActions(answers)

    expect(result.failures, JSON.stringify(result.failures)).toEqual([])
    // Present AND correct: a run that silently produced nothing would also report no failures.
    const generatedPackageJson = JSON.parse(
      await readFile(path.join(workspaceDirectory, 'bare-enter-project', 'package.json'), 'utf8'),
    ) as { name: string; scripts: Record<string, string> }

    expect(generatedPackageJson.name).toBe('bare-enter-project')
    // The default manager is npm, so the gate must have been assembled from the Node modules — the
    // observable proof that the derived `packageManager` answer actually selected a module.
    expect(generatedPackageJson.scripts['check:all']).toBeDefined()
  })
})
