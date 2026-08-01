import { PassThrough } from 'node:stream'
import inquirer from 'inquirer'
import nodePlop from 'node-plop'
import { resolvePlopfilePath } from '../plopfile-path.js'

/**
 * Drives the generator's REAL prompt list with scripted keystrokes.
 *
 * WHY THIS EXISTS. Everything else that touches the prompts either reads the list without answering it
 * (`prompts.test.ts`) or hands `runActions` an answer object built in TypeScript (`layout`, `generation`).
 * Neither renders a question. So nothing covered the parts an operator actually experiences: a question
 * being skipped, an answer being rejected and re-asked, or Ctrl-C. See #44.
 *
 * NO PSEUDO-TERMINAL, AND NO NEW DEPENDENCY. inquirer 9 defaults `skipTTYChecks` to true
 * (`inquirer/lib/ui/baseUI.js`), so a plain `PassThrough` pair is enough — no `isTTY`, no `setRawMode`,
 * both measured as unnecessary.
 *
 * THE ONE NON-OBVIOUS PART, which cost four failed attempts to find. node-plop returns
 * `Object.assign({}, plopfileApi, {…})` — a COPY (`node-plop/src/node-plop.js:234`) — while the generator
 * runner holds the original and calls `plopfileApi.inquirer.prompt(…)`
 * (`node-plop/src/generator-runner.js:29`). So assigning `plop.inquirer = …` mutates an object nothing
 * reads, and the prompts quietly render to the real stdout instead. What DOES reach the runner is replacing
 * `prompt` on the inquirer module itself, which both objects hold by reference. That is a module-global
 * mutation, so it is restored in a `finally` — a leaked patch would silently redirect every later suite in
 * the same worker.
 */

/** One scripted exchange: wait for a question to appear, then send an answer. */
export interface ScriptedResponse {
  /** Text from the prompt's own message, waited for before sending. */
  readonly awaitText: string
  /** Bytes to write, including the newline that submits. */
  readonly send: string
}

export interface DriveResult {
  /** The answers inquirer resolved with, or `undefined` if the run was interrupted. */
  readonly answers?: Record<string, unknown>
  /** The error the run rejected with, if it did. */
  readonly error?: unknown
  /** Everything written to the terminal, with ANSI control sequences removed. */
  readonly screenText: string
}

/**
 * Enter, and the two control bytes the tests need.
 *
 * Written as unicode escapes rather than pasted literals: a raw ESC or ETX in a source file is invisible
 * in most editors and in a diff, which is how one gets deleted by accident.
 */
export const ENTER = '\n'
export const DOWN_ARROW = '\u001B[B'
/**
 * Ctrl-C. Exported but UNUSED, deliberately: inquirer's force-close does
 * `process.kill(process.pid, 'SIGINT')` (`inquirer/lib/ui/baseUI.js:32`), so sending this in-process kills
 * the Vitest worker rather than the prompt. It stays here so the next person reaches for it, finds this
 * comment, and does not rediscover that the hard way — see `interactive-cli.test.ts`'s header.
 *
 * That same self-kill is what used to make the CLI's own interruption path unreachable (#50). `cli.ts` now
 * handles the signal; do not try to reach that path from here, because arriving at it means the worker is
 * already dying.
 */
export const CONTROL_C = '\u0003'
/**
 * One character rubbed out.
 *
 * Needed because a REJECTED answer stays in the input buffer for editing — inquirer re-prompts with the
 * bad text still there rather than clearing it. Measured: replying `core` to a rejected `../escape`
 * produces `../escapecore`. An operator would backspace, so a faithful script has to as well.
 */
export const BACKSPACE = '\u007F'

/** How long to wait for a prompt to render before giving up, in milliseconds. */
const PROMPT_APPEARANCE_TIMEOUT_MS = 5000
/** How often to re-check the accumulated output while waiting, in milliseconds. */
const PROMPT_POLL_INTERVAL_MS = 10

/**
 * Strips ANSI control sequences, so the text can be searched.
 *
 * PRESENCE ONLY — deliberately not a terminal emulator. Cursor moves and redraws mean this is a
 * transcript of everything ever written, not the final visible screen: a message that appeared and was
 * then cleared still shows up here. That is exactly right for "was the operator told X", which is all
 * these tests ask. Asserting on LAYOUT, or on what remains visible at the end, would need a headless
 * terminal (`@xterm/headless`, which is how `@inquirer/testing` does it) and is not worth a dependency
 * until something needs it.
 */
function stripAnsiSequences(rawOutput: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes requires ESC.
  return rawOutput.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '')
}

/**
 * Presents a plain stream pair as the TTY handles inquirer's types ask for.
 *
 * ONE OF THIS FILE'S TWO DECLARATION MISMATCHES; the other is `plop.inquirer`, justified at its use site
 * below. Both are cases where a dependency's TYPES are narrower than its documented runtime contract, which
 * is the only thing a cast is allowed to paper over here — never an error in this file's own logic.
 *
 * inquirer declares `input`/`output` as `NodeJS.ReadStream`/`WriteStream` — TTY handles carrying
 * `setRawMode`, `cursorTo`, `isRaw` and two dozen more. Its runtime requirement is much smaller: it
 * defaults `skipTTYChecks` to true (`inquirer/lib/ui/baseUI.js:61`) and, for these prompt types, never
 * calls a TTY-only member.
 *
 * That is measured, not assumed. A bare `PassThrough` pair — no `isTTY`, no `setRawMode` — drives the
 * entire seven-question flow to a resolved answer set; both shims were tried and removed as unnecessary.
 * If a future inquirer starts calling one of those members, this cast is the thing that was wrong, and the
 * failure will name the missing method.
 *
 */
function asPromptStreams(
  input: PassThrough,
  output: PassThrough,
): { readonly input: NodeJS.ReadStream; readonly output: NodeJS.WriteStream } {
  return {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  }
}

/**
 * Runs the generator's prompts against scripted input and returns the answers plus what was displayed.
 *
 * Each response WAITS for its question to render rather than sleeping a fixed interval. A fixed delay is
 * the classic source of flake here — it is either too short on a loaded machine or wasted time on an idle
 * one, and when it is too short the failure looks like a broken prompt rather than a broken test.
 */
export async function drivePrompts(script: readonly ScriptedResponse[]): Promise<DriveResult> {
  const scriptedInput = new PassThrough()
  const capturedOutput = new PassThrough()
  let rawOutput = ''
  capturedOutput.on('data', (chunk) => {
    rawOutput += String(chunk)
  })

  const plop = await nodePlop(resolvePlopfilePath())
  const originalPrompt = inquirer.prompt
  // The second declaration mismatch (see `asPromptStreams`): node-plop exposes `inquirer` at runtime as a
  // documented passthrough (`node-plop/src/node-plop.js:223`) but omits it from `NodePlopAPI`. And per this
  // file's header, the module object is the only thing the returned api and the runner both hold.
  const plopWithInquirer = plop as unknown as { readonly inquirer: { prompt: typeof inquirer.prompt } }
  plopWithInquirer.inquirer.prompt = inquirer.createPromptModule(asPromptStreams(scriptedInput, capturedOutput))

  try {
    // ANNOTATED, not cast. `runPrompts` is declared `Promise<any>`, so this narrows rather than
    // suppresses — without it every answer downstream would be `any`. `cli.ts` does the same thing the
    // same way, for the same reason.
    const answersPromise: Promise<Record<string, unknown>> = plop.getGenerator('generate').runPrompts()
    // Attached before the first await so a rejection during the script cannot become an unhandled one.
    const settled = answersPromise.then(
      (answers) => ({ answers }),
      (error: unknown) => ({ error }),
    )

    for (const { awaitText, send } of script) {
      await waitForText(() => stripAnsiSequences(rawOutput), awaitText, settled)
      scriptedInput.write(send)
    }

    const outcome = await settled
    return { ...outcome, screenText: stripAnsiSequences(rawOutput) }
  } finally {
    inquirer.prompt = originalPrompt
  }
}

/**
 * Waits until the rendered text contains `awaitText`, or the run ends first.
 *
 * Racing against the run matters: a Ctrl-C script ends the prompts early, and without this the next wait
 * would block for the full timeout before reporting a confusing miss instead of the real outcome.
 */
async function waitForText(readScreenText: () => string, awaitText: string, runEnded: Promise<unknown>): Promise<void> {
  const deadline = Date.now() + PROMPT_APPEARANCE_TIMEOUT_MS
  let runHasEnded = false
  void runEnded.then(() => {
    runHasEnded = true
  })

  while (Date.now() < deadline) {
    if (readScreenText().includes(awaitText)) {
      return
    }
    if (runHasEnded) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, PROMPT_POLL_INTERVAL_MS))
  }

  throw new Error(
    `the prompt never displayed ${JSON.stringify(awaitText)} within ${PROMPT_APPEARANCE_TIMEOUT_MS}ms.\n` +
      `What it displayed instead:\n${readScreenText()}`,
  )
}
