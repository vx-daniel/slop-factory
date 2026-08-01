import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import nodePlop from 'node-plop'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolvePlopfilePath } from '../plopfile-path.js'
import { BACKSPACE, DOWN_ARROW, drivePrompts, ENTER } from './drive-prompts.js'

/**
 * The interactive session, rendered and answered — the part of the CLI no other suite reaches.
 *
 * `cli.test.ts` spawns the binary but can only reach the arguments that DO NOT prompt, because
 * `runGenerate` refuses a non-TTY stdin. `prompts.test.ts` walks the prompt list as data and never renders
 * it. This file is the only place a question is displayed and answered. See #44.
 *
 * CTRL-C IS ABSENT, AND CANNOT BE HERE. inquirer's force-close handler does
 * `process.kill(process.pid, 'SIGINT')` (`inquirer/lib/ui/baseUI.js:32`) — a real Ctrl-C signals the whole
 * process, which in a Vitest worker kills the worker. Measured: the two tests that tried it took the file
 * down with them, reporting four of six tests as never run.
 *
 * Installing a SIGINT handler to swallow it was rejected rather than untried. Vitest handles SIGINT itself
 * as "cancel the run", so competing for that signal risks a CANCELLED run reporting as a passing one, which
 * is a worse outcome than the gap. Ctrl-C therefore needs a real subprocess with a pseudo-terminal, which
 * is what the remaining part of #44 is for.
 *
 * So the interruption path is covered in halves, and neither half is this file: `cli.test.ts` proves
 * `isPromptInterruption` accepts the three error shapes inquirer produces, and nothing yet proves a real
 * Ctrl-C produces one of them or that the exit code is 130.
 */

/** Distinctive fragments of each prompt's own message, used to wait for it and to assert it appeared. */
const PROJECT_NAME_QUESTION = 'Name of the project'
const DESTINATION_QUESTION = 'Directory to create it in'
const LAYOUT_QUESTION = 'Which layout?'
const PACKAGE_NAMES_QUESTION = 'Names of the packages'
const PACKAGE_MANAGER_QUESTION = 'Which package manager?'
const FEATURES_QUESTION = 'Which optional features'

/** A package name the validator refuses, and the reason it gives. */
const REJECTED_PACKAGE_NAME = '../escape'

let workspaceDirectory: string

beforeAll(async () => {
  workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), 'slop-factory-interactive-'))
})

afterAll(async () => {
  await rm(workspaceDirectory, { recursive: true, force: true })
})

describe('accepting every default', () => {
  it('skips the workspace question and generates a project', async () => {
    const { answers, screenText } = await drivePrompts([
      { awaitText: PROJECT_NAME_QUESTION, send: `bare-enter${ENTER}` },
      { awaitText: DESTINATION_QUESTION, send: `${workspaceDirectory}${ENTER}` },
      { awaitText: LAYOUT_QUESTION, send: ENTER },
      { awaitText: PACKAGE_MANAGER_QUESTION, send: ENTER },
      { awaitText: FEATURES_QUESTION, send: ENTER },
    ])

    // The skip, asserted on the ANSWERS rather than on the screen. A question that was never asked leaves
    // no answer, which is a stronger statement than "its text is absent from a transcript" — the transcript
    // records everything ever drawn, including text later cleared.
    expect(answers).toEqual({
      projectName: 'bare-enter',
      projectPath: workspaceDirectory,
      projectStructure: 'single',
      packageManager: 'npm',
      enableFeatures: ['config'],
    })
    expect(screenText, 'the workspace-only question was asked under the single layout').not.toContain(
      PACKAGE_NAMES_QUESTION,
    )

    // Answered is not generated: `runPrompts` only collects. Running the actions with what the operator
    // actually typed is what proves the two halves fit together.
    const plop = await nodePlop(resolvePlopfilePath())
    const result = await plop.getGenerator('generate').runActions(answers ?? {})

    expect(result.failures, JSON.stringify(result.failures)).toEqual([])
    expect(await readdir(path.join(workspaceDirectory, 'bare-enter'))).toContain('package.json')
  })
})

describe('choosing the workspace layout', () => {
  it('asks the question the single layout skips', async () => {
    // One Down before Enter, because `monorepo` is the second choice. This is the only test that navigates
    // a list rather than accepting its first entry, and it is what proves the skip above is conditional
    // rather than the question simply not existing.
    const { answers, screenText } = await drivePrompts([
      { awaitText: PROJECT_NAME_QUESTION, send: `workspace-run${ENTER}` },
      { awaitText: DESTINATION_QUESTION, send: `${workspaceDirectory}${ENTER}` },
      { awaitText: LAYOUT_QUESTION, send: `${DOWN_ARROW}${ENTER}` },
      { awaitText: PACKAGE_NAMES_QUESTION, send: `core,api${ENTER}` },
      { awaitText: PACKAGE_MANAGER_QUESTION, send: ENTER },
      { awaitText: FEATURES_QUESTION, send: ENTER },
    ])

    expect(screenText).toContain(PACKAGE_NAMES_QUESTION)
    expect(answers?.projectStructure).toBe('monorepo')
    // The comma-separated answer arrives as ONE string from the prompt — splitting it is
    // `normalizePackageNames`' job, and this is the only test that sees the un-split form an operator types.
    expect(answers?.packageNames).toBe('core,api')
  })
})

describe('an answer the validator rejects', () => {
  it('shows the reason and asks again, rather than accepting it', async () => {
    // THE CASE THAT ONLY EXISTS INTERACTIVELY. A rejected answer is re-prompted, which no non-interactive
    // path can reproduce: `runActions` throws on a bad value instead, and the operator never sees the
    // difference between "declined, try again" and "crashed".
    const { answers, screenText } = await drivePrompts([
      { awaitText: PROJECT_NAME_QUESTION, send: `rejected-then-fixed${ENTER}` },
      { awaitText: DESTINATION_QUESTION, send: `${workspaceDirectory}${ENTER}` },
      { awaitText: LAYOUT_QUESTION, send: `${DOWN_ARROW}${ENTER}` },
      { awaitText: PACKAGE_NAMES_QUESTION, send: `${REJECTED_PACKAGE_NAME}${ENTER}` },
      // Waiting for the VALIDATOR'S message is what proves the rejection rendered; if it never appeared,
      // this step times out and reports the transcript rather than hanging.
      //
      // Backspacing first, because the rejected text is still in the buffer — see BACKSPACE. Typing the
      // replacement without clearing produced `../escapecore`, which is what this script did on its first
      // run and is worth knowing: being re-asked does not mean starting from blank.
      {
        awaitText: 'single directory name',
        send: `${BACKSPACE.repeat(REJECTED_PACKAGE_NAME.length)}core${ENTER}`,
      },
      { awaitText: PACKAGE_MANAGER_QUESTION, send: ENTER },
      { awaitText: FEATURES_QUESTION, send: ENTER },
    ])

    expect(screenText, 'the operator was not told why the name was refused').toContain('single directory name')
    // The rejected value must not survive anywhere in the answers — being re-asked is only useful if the
    // second answer is the one kept.
    expect(answers?.packageNames).toBe('core')
  })
})

describe('the harness leaves no trace', () => {
  it('removes the exit listener inquirer registers, so later suites are unaffected', async () => {
    // inquirer's baseUI registers `process.on('exit')` per prompt session and removes it in `close()`.
    // Driving prompts IN-PROCESS means a session that failed to close would leak that listener into the
    // Vitest worker and fire at teardown, breaking unrelated suites that share it.
    const listenersBefore = process.listenerCount('exit')

    await drivePrompts([
      { awaitText: PROJECT_NAME_QUESTION, send: `listener-check${ENTER}` },
      { awaitText: DESTINATION_QUESTION, send: `${workspaceDirectory}${ENTER}` },
      { awaitText: LAYOUT_QUESTION, send: ENTER },
      { awaitText: PACKAGE_MANAGER_QUESTION, send: ENTER },
      { awaitText: FEATURES_QUESTION, send: ENTER },
    ])

    expect(process.listenerCount('exit'), 'a prompt session leaked its exit listener').toBe(listenersBefore)
  })
})
