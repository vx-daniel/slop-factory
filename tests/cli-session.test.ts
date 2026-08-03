import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import inquirer from 'inquirer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CTRL_C,
  DESTINATION_QUESTION,
  driveCommandLine,
  ENTER,
  FEATURES_QUESTION,
  LAYOUT_QUESTION,
  PACKAGE_MANAGER_QUESTION,
  PROJECT_NAME_QUESTION,
} from './drive-prompts.js'

/**
 * `runGenerate`'s SECOND HALF — everything that happens after the questions are answered.
 *
 * NOTHING EXECUTED ANY OF THIS. Measured on #52 with four markers compiled into `cli.ts` and every suite
 * run: all four counted zero hits. `cli.test.ts` spawns the real binary, but `runGenerate` refuses a
 * non-TTY stdin seventeen lines in, and a spawned child's stdin is a pipe. `prompt-session.test.ts` answers
 * real questions, but through the plopfile — it never loads `cli.ts` at all. Two suites, each plausibly
 * named as though it covered this, neither reaching it. The same shape as a guard that is green while
 * inert, one level up: not an assertion that cannot fail, but a FILE that never runs what its name implies.
 *
 * IN-PROCESS, NOT SPAWNED, and that is a departure from `cli.test.ts` worth stating. A subprocess is the
 * better test where it can reach the code — it covers the shebang, the bin's missing-build branch, and
 * which stream each message went to. It cannot reach here: nothing short of a pseudo-terminal gives a child
 * a TTY stdin. So this file patches `process.stdin.isTTY` instead, which is the smallest lie that makes the
 * real code path reachable, and leaves the dispatch cases to the subprocess suite that already covers them.
 *
 * MUTATION EVIDENCE — every assertion here was watched failing against a deliberate break, because a
 * green prose-shaped assertion is indistinguishable from a working one. Broken in `cli.ts`: the
 * `results.failures` check (exit code went to 0), the failure-reporting loop alone with the exit code left
 * intact, the "Done." message, the per-change output loop, and the `INTERRUPTED` branch. Broken in
 * `drive-prompts.ts`: the `process.stdin.isTTY` restore.
 *
 * THAT LAST ONE DID NOT FAIL AT FIRST, which is why it is worth naming. The restore check originally
 * compared `isTTY` either side of one session; with the restore deleted, every test after the first read an
 * already-leaked `true` as its own baseline and matched it. It now compares against a snapshot taken at
 * module load. A leaked VALUE is invisible to a delta — a leaked function object is not, which is why the
 * three identity checks beside it caught their own bug (a stacking `.bind`) on first run.
 *
 * WHAT IS STILL NOT COVERED, so nobody reads a green run as more than it is:
 *
 *   - The keep-alive timer's NECESSITY. Replacing it with a one-shot passes everything here, because the
 *     bug it prevents needs the event loop to EMPTY and a test runner's loop never does. Principled, not
 *     missing: any environment able to observe the failure is one where the failure cannot occur. Evidenced
 *     by the pty spike on #50 and stated as uncovered in `cli.ts`.
 *   - `ERR_USE_AFTER_CLOSE` reaching the `catch` in `runGenerate`. ATTEMPTED AND MEASURED: ending the
 *     injected input stream under a live prompt, and separately destroying it, both leave the run hanging
 *     rather than rejecting — the session never settles and no error is delivered. A PassThrough closing is
 *     not the same event as a real stdin closing, so the shape that reaches that `catch` needs a terminal
 *     this harness does not have.
 */

/** Where the CLI reports success, and the phrase this suite waits on to know it got there. */
const DONE_MESSAGE = 'Done.'
/** How `reportCancelled` tells the operator nothing happened. */
const CANCELLED_MESSAGE = 'Cancelled — nothing was written.'
/** The prefix `runGenerate` puts on every failed action. */
const FAILURE_PREFIX = 'FAILED'
/** The action that refuses a destination with anything already in it. */
const EMPTY_DESTINATION_ACTION = 'assertEmptyDestination'

const EXIT_SUCCESS = 0
const EXIT_FAILURE = 1
/** 128 + SIGINT, which is what a shell reports for a Ctrl-C. */
const EXIT_INTERRUPTED = 130

/**
 * What `process.stdin.isTTY` looks like before ANY session has touched it.
 *
 * Captured at module load, which is the only moment guaranteed to be pristine. An either-side-of-one-session
 * delta cannot see a leak here, and that is not theoretical: deleting the restore in `drive-prompts.ts` left
 * this suite fully green, because every test after the first read an already-leaked `true` as its own
 * baseline and compared it to the same `true` afterwards. A VALUE that leaks to a constant is invisible to a
 * delta; the identity checks below do not have that problem, because a leaked wrapper is a different object.
 */
const PRISTINE_STDIN_IS_TTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')

let workspaceDirectory: string

beforeAll(async () => {
  workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), 'slop-factory-cli-session-'))
})

afterAll(async () => {
  await rm(workspaceDirectory, { recursive: true, force: true })
})

/** The shortest complete script: every question answered, all defaults except the two that have none. */
function scriptAcceptingDefaults(projectName: string): ReadonlyArray<{ awaitText: string; send: string }> {
  return [
    { awaitText: PROJECT_NAME_QUESTION, send: `${projectName}${ENTER}` },
    { awaitText: DESTINATION_QUESTION, send: `${workspaceDirectory}${ENTER}` },
    { awaitText: LAYOUT_QUESTION, send: ENTER },
    { awaitText: PACKAGE_MANAGER_QUESTION, send: ENTER },
    { awaitText: FEATURES_QUESTION, send: ENTER },
  ]
}

describe('a session that runs to completion', () => {
  it('reports what it wrote, says it is done, and exits 0', async () => {
    const projectName = 'cli-success'
    const { exitCode, printedText, error } = await driveCommandLine(scriptAcceptingDefaults(projectName))

    // Reported FIRST. If the run rejected, the exit-code assertion below would say only "undefined is not
    // 0", discarding the reason — and the reason is the whole diagnostic.
    expect(error, `the CLI rejected instead of returning: ${String(error)}`).toBeUndefined()
    expect(exitCode).toBe(EXIT_SUCCESS)
    expect(printedText, 'the operator was never told the run finished').toContain(DONE_MESSAGE)
    // The per-change loop, asserted on a path the run actually produced rather than on the word "add".
    // `runGenerate` prints one line per change, and printing NOTHING there would still reach "Done." —
    // so the success message alone does not prove this loop ran.
    //
    // `tsconfig.json` rather than `package.json`, which is not the obvious choice and is the correct one:
    // package.json is written by the `writePackageJson` action, whose line reports a bare filename and a
    // script count. Its absolute path is never printed, so asserting on it failed against a correct run.
    expect(printedText).toContain(path.join(workspaceDirectory, projectName, 'tsconfig.json'))
    expect(printedText).not.toContain(FAILURE_PREFIX)

    // Answered and reported is not written. Reading the tree is what proves the actions ran.
    expect(await readdir(path.join(workspaceDirectory, projectName))).toContain('package.json')
  })
})

describe('a session whose actions fail', () => {
  it('reports the failure and exits 1', async () => {
    // THE CHEAPEST REAL TRIGGER. The destination prompt only validates that the PARENT exists, so a project
    // name whose directory is already occupied passes every question and fails at `assertEmptyDestination`
    // — a real action failure rather than a simulated one. Nothing covered this refusal before, either.
    const projectName = 'cli-occupied'
    const occupiedDirectory = path.join(workspaceDirectory, projectName)
    await mkdir(occupiedDirectory, { recursive: true })
    await writeFile(path.join(occupiedDirectory, 'already-here.txt'), 'in the way\n')

    const { exitCode, printedText } = await driveCommandLine(scriptAcceptingDefaults(projectName))

    expect(exitCode).toBe(EXIT_FAILURE)
    // BOTH, and the second one is the point. `runGenerate` returns 1 for an action failure and would also
    // return 1 from an unrelated crash, so an exit-code-only assertion passes against a deleted
    // `results.failures` check. Requiring the reported failure line is what makes the mutation fail.
    expect(printedText, 'the failing action was never reported').toContain(
      `${FAILURE_PREFIX} ${EMPTY_DESTINATION_ACTION}`,
    )
    expect(printedText).not.toContain(DONE_MESSAGE)
  })
})

describe('a session the operator abandons', () => {
  it('reports the cancellation, writes nothing, and exits 130', async () => {
    // CTRL-C END TO END, which #52 rated as only likely to work and `prompt-session.test.ts` recorded as
    // needing a pseudo-terminal. Both were wrong, for one measurable reason: inquirer's force-close raises
    // SIGINT on `process.pid`, and going through `cli.ts` means `listenForInterruption` is already
    // installed to catch it. In a forks worker there is no competing listener — Vitest's own SIGINT
    // handling lives in the parent — so the signal is handled rather than fatal.
    const projectName = 'cli-cancelled'
    const { exitCode, printedText } = await driveCommandLine([
      { awaitText: PROJECT_NAME_QUESTION, send: `${projectName}${ENTER}` },
      { awaitText: DESTINATION_QUESTION, send: `${workspaceDirectory}${ENTER}` },
      // Abandoned mid-list, so the run ends with questions still unanswered.
      { awaitText: LAYOUT_QUESTION, send: CTRL_C },
    ])

    expect(exitCode).toBe(EXIT_INTERRUPTED)
    expect(printedText).toContain(CANCELLED_MESSAGE)
    // The message's own claim, checked rather than trusted. `runGenerate` prints "nothing was written"
    // because it cancels before `runActions`; if that ever stops being true the message becomes a lie, and
    // an operator who believed it would not go looking for a half-written tree.
    await expect(readdir(path.join(workspaceDirectory, projectName))).rejects.toThrow()
  })

  it('still runs the tests that follow it', () => {
    // NOT A FORMALITY. Vitest treats SIGINT as "cancel the run", and a cancelled run can report as a
    // passing one — which would make the test above green while silently ending the file. This executing
    // at all is the evidence that the signal was contained.
    expect(true).toBe(true)
  })
})

describe('the harness leaves no trace', () => {
  it('restores stdin, both output streams, and the prompt module', async () => {
    // Measured either side of ONE session, not against a file-scope baseline — a delta across the whole
    // file is contaminated by the tests above and can pass having driven nothing. Same reasoning as the
    // equivalent check in `prompt-session.test.ts`.
    //
    // `isTTY` IS THE DANGEROUS ONE. Left true, every later suite in this worker would believe it has a
    // terminal, and the guard this file exists to get past would stop guarding anything.
    const stdoutWriteBefore = process.stdout.write
    const stderrWriteBefore = process.stderr.write
    const promptBefore = inquirer.prompt

    await driveCommandLine(scriptAcceptingDefaults('cli-restores'))

    // Against the PRISTINE snapshot, not against a reading taken a moment ago — see its declaration. Every
    // session in this file has run by now, so this also catches a leak from any of them.
    expect(Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), 'stdin was left presented as a terminal').toEqual(
      PRISTINE_STDIN_IS_TTY,
    )
    expect(process.stdout.write, 'the harness left stdout captured').toBe(stdoutWriteBefore)
    expect(process.stderr.write, 'the harness left stderr captured').toBe(stderrWriteBefore)
    expect(inquirer.prompt, 'the harness left its prompt module patched in').toBe(promptBefore)
  })
})
