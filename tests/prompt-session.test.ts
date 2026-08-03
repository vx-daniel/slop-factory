import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import inquirer from 'inquirer'
import nodePlop from 'node-plop'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolvePlopfilePath } from '../plopfile-path.js'
import {
  BACKSPACE,
  DESTINATION_QUESTION,
  DOWN_ARROW,
  drivePrompts,
  ENTER,
  FEATURES_QUESTION,
  LAYOUT_QUESTION,
  PACKAGE_MANAGER_QUESTION,
  PACKAGE_NAMES_QUESTION,
  PROJECT_NAME_QUESTION,
} from './drive-prompts.js'

/**
 * The interactive session, rendered and answered — the part of the CLI no other suite reaches.
 *
 * `cli.test.ts` spawns the binary but can only reach the arguments that DO NOT prompt, because
 * `runGenerate` refuses a non-TTY stdin. `prompts.test.ts` walks the prompt list as data and never renders
 * it. This file is the only place a question is displayed and answered. See #44.
 *
 * CTRL-C IS ABSENT, AND CANNOT BE HERE. inquirer's force-close handler does
 * `process.kill(process.pid, 'SIGINT')` (`inquirer`'s `onForceClose`) — a real Ctrl-C signals the whole
 * process, which in a Vitest worker kills the worker. Measured: the two tests that tried it took the file
 * down with them, reporting four of six tests as never run.
 *
 * Installing a SIGINT handler HERE to swallow it was rejected rather than untried: a handler this file
 * owned would exist only to keep the worker alive, which is a test faking the condition it is meant to
 * observe.
 *
 * WHAT IS DANGEROUS IS THE MISSING HANDLER, NOT THE SIGNAL — and that distinction is now measured rather
 * than assumed (#52). `cli-session.test.ts` sends a real Ctrl-C in this same worker and survives, because
 * it goes through `cli.ts`, which installs `listenForInterruption` before any prompt renders. That is
 * PRODUCTION code handling the signal, not test scaffolding. This file drives `runPrompts` directly, so no
 * handler is installed and Node's default action still kills the worker — the warning above stands for
 * anything written here.
 *
 * The old conclusion that Ctrl-C "needs a pseudo-terminal" was wrong, and so was the fear of competing with
 * Vitest for the signal: `process.listenerCount('SIGINT')` is 0 inside a forks worker before `cli.ts` runs,
 * and inquirer signals `process.pid` — the worker — while Vitest's cancel-the-run handling lives in the
 * parent. Measured, with a check that tests after the Ctrl-C one still execute.
 *
 * A PSEUDO-TERMINAL SPIKE FOUND THE PATH WAS BROKEN, AND IT IS NOW FIXED (#50). Before the fix, three runs
 * of three: killed by SIGNAL 2 with exit code 0, and "Cancelled — nothing was written." never printed —
 * inquirer raises SIGINT on the process, `cli.ts` had no handler, and Node's default action terminated
 * before the `catch` could run. `cli.ts` now listens for it; the same spike reports exit 130, the message
 * printed, and an empty destination, three runs of three.
 *
 * That verification lives in a spike rather than in this suite for the reason above: sending Ctrl-C
 * in-process kills the worker. The gap is narrower than it was — what remains untested here is the exit
 * code and the message, both proven by hand and neither reachable without a PTY.
 */

/** A package name the validator refuses. */
const REJECTED_PACKAGE_NAME = '../escape'

/**
 * The refusal, matched in its QUOTED form.
 *
 * `single directory name` alone is not unique to this validator — `plopfile.ts` emits that wording for the
 * project name too — and the bare name also appears in the transcript simply because it was typed. The
 * quoted `"../escape"` only ever comes from the validator's own message, so it discriminates.
 */
const REFUSAL_MESSAGE = `"${REJECTED_PACKAGE_NAME}" must be a single directory name`

let workspaceDirectory: string

beforeAll(async () => {
  workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), 'slop-factory-interactive-'))
})

afterAll(async () => {
  await rm(workspaceDirectory, { recursive: true, force: true })
})

describe('accepting every default', () => {
  it('skips the workspace question and generates a project', async () => {
    const { answers } = await drivePrompts([
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
    // Answered is not generated: `runPrompts` only collects. Running the actions with what the operator
    // actually typed is what proves the two halves fit together.
    const plop = await nodePlop(resolvePlopfilePath())
    // Thrown rather than defaulted to `{}`. An empty answer set is a HARNESS failure, and passing it on
    // would surface as a plopfile complaint about a missing package manager — blaming the generator for
    // something the test did. Throwing also narrows the type, so no cast is needed.
    if (answers === undefined) {
      throw new Error('the prompt session resolved without answers')
    }
    const result = await plop.getGenerator('generate').runActions(answers)

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
        awaitText: REFUSAL_MESSAGE,
        send: `${BACKSPACE.repeat(REJECTED_PACKAGE_NAME.length)}core${ENTER}`,
      },
      { awaitText: PACKAGE_MANAGER_QUESTION, send: ENTER },
      { awaitText: FEATURES_QUESTION, send: ENTER },
    ])

    expect(screenText, 'the operator was not told why the name was refused').toContain(REFUSAL_MESSAGE)
    // The rejected value must not survive anywhere in the answers — being re-asked is only useful if the
    // second answer is the one kept.
    expect(answers?.packageNames).toBe('core')
  })
})

describe('the harness leaves no trace', () => {
  it('restores the patched module and the exit listener', async () => {
    // TWO LEAKS, and the harness header calls the second one the dangerous one: a `prompt` left pointing at
    // a dead stream would silently redirect every later suite in this worker. Only the listener was checked
    // before, which is the smaller of the two.
    //
    // Both are measured immediately either side of ONE session, not against a baseline taken at file scope —
    // a delta across the whole file is contaminated by the tests above and can pass having driven nothing.
    const promptBeforeSession = inquirer.prompt
    const listenersBefore = process.listenerCount('exit')

    await drivePrompts([
      { awaitText: PROJECT_NAME_QUESTION, send: `listener-check${ENTER}` },
      { awaitText: DESTINATION_QUESTION, send: `${workspaceDirectory}${ENTER}` },
      { awaitText: LAYOUT_QUESTION, send: ENTER },
      { awaitText: PACKAGE_MANAGER_QUESTION, send: ENTER },
      { awaitText: FEATURES_QUESTION, send: ENTER },
    ])

    expect(inquirer.prompt, 'the harness left its prompt module patched in').toBe(promptBeforeSession)
    expect(process.listenerCount('exit'), 'a prompt session leaked its exit listener').toBe(listenersBefore)
  })
})
