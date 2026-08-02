import { PassThrough } from 'node:stream'
import inquirer from 'inquirer'
import nodePlop from 'node-plop'
import { runCommandLine } from '../cli.js'
import { resolvePlopfilePath } from '../plopfile-path.js'

/**
 * Drives the generator's REAL prompt list with scripted keystrokes.
 *
 * WHY THIS EXISTS. Everything else that touches the prompts either reads the list without answering it
 * (`prompts.test.ts`) or hands `runActions` an answer object built in TypeScript (`layout`, `generation`).
 * Neither renders a question. So nothing covered the parts an operator actually experiences: a question
 * being skipped, an answer being rejected and re-asked, or Ctrl-C. See #44.
 *
 * TWO ENTRY POINTS, over one shared core.
 *
 *   - `drivePrompts` answers the prompt list DIRECTLY, through node-plop. It stops at the answers, so it
 *     can say what a question produced but nothing about what the CLI then does with it.
 *   - `driveCommandLine` answers the same list THROUGH `cli.ts`, so the half of `runGenerate` that follows
 *     the answers — the change log, "Done.", the failure exit, the cancellation report — is reached at all.
 *     Nothing executed that half before; see #52.
 *
 * The extra patches the second one needs are applied AROUND the core rather than switched inside it, so
 * the shared path has no branch and the direct driver cannot accidentally acquire them.
 *
 * NO PSEUDO-TERMINAL, AND NO NEW DEPENDENCY. inquirer 9 defaults `skipTTYChecks` to true
 * (`inquirer/lib/ui/baseUI.js`), so a plain `PassThrough` pair is enough — no `isTTY`, no `setRawMode`,
 * both measured as unnecessary. `driveCommandLine` sets `process.stdin.isTTY` anyway, but for a different
 * reason: `cli.ts` REFUSES a non-TTY stdin before it reaches any prompt. That guard, not inquirer, is why
 * no suite could reach `runGenerate`'s second half.
 *
 * THE ONE NON-OBVIOUS PART, which cost four failed attempts to find. node-plop returns
 * `Object.assign({}, plopfileApi, {…})` — a COPY (`node-plop`'s `nodePlopApi` assembly) — while the generator
 * runner holds the original and calls `plopfileApi.inquirer.prompt(…)`
 * (`node-plop`'s `runGeneratorPrompts`). So assigning `plop.inquirer = …` mutates an object nothing
 * reads, and the prompts quietly render to the real stdout instead. What DOES reach the runner is replacing
 * `prompt` on the inquirer module itself, which both objects hold by reference. That is a module-global
 * mutation, so it is restored in a `finally` — a leaked patch would silently redirect every later suite in
 * the same worker.
 *
 * PATCHING THE MODULE IS ALSO WHAT MAKES THE SECOND DRIVER POSSIBLE. `cli.ts` builds its own plop instance
 * that this file never sees, so there is no `plop.inquirer` here to reach for — the module object is the
 * only thing both sides hold. `drivePrompts` asserts that identity rather than assuming it.
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

export interface CommandLineResult {
  /** What `runCommandLine` returned — the code the binary would exit with. */
  readonly exitCode?: number
  /** The error the run rejected with, if it did. */
  readonly error?: unknown
  /**
   * What `cli.ts` itself wrote, across BOTH standard streams.
   *
   * Separate from `screenText` because they come from different places and mean different things: the
   * prompts render into an injected stream, while `cli.ts` writes to `process.stdout`/`process.stderr`
   * directly. Asserting the CLI's own report against the prompt transcript would match a question's text
   * as readily as an answer's consequence.
   */
  readonly printedText: string
  /** Everything the PROMPTS drew, with ANSI control sequences removed. */
  readonly screenText: string
}

/**
 * The keystrokes a script can send.
 *
 * Written as unicode escapes rather than pasted literals: a raw ESC or ETX in a source file is invisible
 * in most editors and in a diff, which is how one gets deleted by accident.
 */
export const ENTER = '\n'
export const DOWN_ARROW = '\u001B[B'
/**
 * One character rubbed out.
 *
 * Needed because a REJECTED answer stays in the input buffer for editing — inquirer re-prompts with the
 * bad text still there rather than clearing it. Measured: replying `core` to a rejected `../escape`
 * produces `../escapecore`. An operator would backspace, so a faithful script has to as well.
 */
export const BACKSPACE = '\u007F'
/**
 * Ctrl-C, as the byte a terminal actually sends.
 *
 * ONLY SAFE THROUGH `driveCommandLine`, and that distinction is why it lives beside the harness rather
 * than in a test file. inquirer's force-close ends with `process.kill(process.pid, 'SIGINT')`. Sent through
 * `drivePrompts` nothing is listening, so Node's default action kills the Vitest worker and takes the rest
 * of the file down with it — measured, see `prompt-session.test.ts`. Sent through `driveCommandLine`,
 * `cli.ts` has already installed `listenForInterruption` by the time a prompt is live, and that handler is
 * the only SIGINT listener in the worker (measured: `process.listenerCount('SIGINT')` is 0 beforehand).
 */
export const CTRL_C = '\u0003'

/**
 * Distinctive fragments of each prompt's own message, used to wait for one and to assert it appeared.
 *
 * SHARED, because both drivers script the same generator. They lived in `prompt-session.test.ts` while it
 * was the only caller; `cli-session.test.ts` answering the same questions is what made a second copy the
 * alternative, and two copies of a prompt's wording drift the first time a message is reworded.
 */
export const PROJECT_NAME_QUESTION = 'Name of the project'
export const DESTINATION_QUESTION = 'Directory to create it in'
export const LAYOUT_QUESTION = 'Which layout?'
export const PACKAGE_NAMES_QUESTION = 'Names of the packages'
export const PACKAGE_MANAGER_QUESTION = 'Which package manager?'
export const FEATURES_QUESTION = 'Which optional features'

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
 * ONE OF THIS FILE'S DECLARATION MISMATCHES; the others are `plop.inquirer` and the stream writers in
 * `captureProcessOutput`, each justified at its own use site. Every one is a case where a dependency's or
 * Node's TYPES are narrower than the documented runtime contract, which is the only thing a cast is allowed
 * to paper over here — never an error in this file's own logic.
 *
 * inquirer declares `input`/`output` as `NodeJS.ReadStream`/`WriteStream` — TTY handles carrying
 * `setRawMode`, `cursorTo`, `isRaw` and two dozen more. Its runtime requirement is much smaller: it
 * defaults `skipTTYChecks` to true (`inquirer`'s `setupReadlineOptions`) and, for these prompt types, never
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
 * The generator to drive, and the CLI subcommand that runs it.
 *
 * One constant for both because they are deliberately the same word — `cli.ts` says so at its own
 * `GENERATE_COMMAND`, which is not exported.
 */
const GENERATOR_NAME = 'generate'

/**
 * Makes `process.stdin` look like a terminal, and yields the undo.
 *
 * `runGenerate` refuses a non-TTY stdin, so without this every `driveCommandLine` session would stop
 * seventeen lines in. Restoring the ORIGINAL DESCRIPTOR rather than assigning a value back matters:
 * `isTTY` is absent on a piped stdin, and leaving `false` where there was nothing is still a change —
 * every later suite in this worker reads the same `process.stdin`.
 */
function presentStdinAsTerminal(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

  return (): void => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(process.stdin, 'isTTY')
      return
    }
    Object.defineProperty(process.stdin, 'isTTY', originalDescriptor)
  }
}

/**
 * Diverts everything written to the process's own output streams into a string.
 *
 * BOTH STREAMS INTO ONE BUFFER, on purpose. `cli.ts` splits its reporting across them — the change log and
 * "Done." to stdout, failures and the cancellation notice to stderr — and a test asking "was the operator
 * told X" does not care which. Which stream carried a message is already covered, by the subprocess cases
 * in `cli.test.ts` that can see them separately.
 */
function captureProcessOutput(): { text: () => string; restore: () => void } {
  // Held UNBOUND, and that is not an oversight. Restoring `original.bind(stream)` puts back a different
  // function object than the one taken, so a second session would capture the wrapper the first restored
  // and stack another layer every time. Caught by the restore assertion in `cli-session.test.ts`, which
  // compares identity. Nothing here ever calls the original, so there is nothing for a bind to fix.
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  let captured = ''

  // The declared signature carries overloads for encodings and callbacks that `cli.ts` never uses; it
  // passes a plain string. Accepting the chunk and reporting success is the whole contract needed here.
  const captureChunk = (chunk: string | Uint8Array): boolean => {
    captured += String(chunk)
    return true
  }
  process.stdout.write = captureChunk as typeof process.stdout.write
  process.stderr.write = captureChunk as typeof process.stderr.write

  return {
    text: (): string => captured,
    restore: (): void => {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
    },
  }
}

/** What a scripted session produced: whichever of these two settled, plus the prompt transcript. */
interface ScriptedSessionOutcome<TResult> {
  readonly result?: TResult
  readonly error?: unknown
  readonly screenText: string
}

/**
 * Plays a script against whatever `beginSession` starts, with the prompts wired to injected streams.
 *
 * THE SHARED CORE of both drivers. It owns the one patch they both need — `inquirer.prompt` — and the
 * wait-then-send loop. Callers that need more patching apply it around this call, so this path stays
 * branch-free.
 *
 * `beginSession` is invoked AFTER the patch is installed and is not awaited here: the returned promise is
 * raced against the script, because the session only progresses as answers arrive.
 *
 * Each response WAITS for its question to render rather than sleeping a fixed interval. A fixed delay is
 * the classic source of flake here — it is either too short on a loaded machine or wasted time on an idle
 * one, and when it is too short the failure looks like a broken prompt rather than a broken test.
 */
async function runScriptedSession<TResult>(
  script: readonly ScriptedResponse[],
  beginSession: () => Promise<TResult>,
): Promise<ScriptedSessionOutcome<TResult>> {
  const scriptedInput = new PassThrough()
  const capturedOutput = new PassThrough()
  let rawOutput = ''
  capturedOutput.on('data', (chunk) => {
    rawOutput += String(chunk)
  })

  // Patched on the MODULE, which is what reaches the generator runner and what `cli.ts`'s own plop instance
  // holds too — see this file's header. Restored in the `finally`, because a leaked patch would silently
  // redirect every later suite in this worker.
  const originalPrompt = inquirer.prompt
  inquirer.prompt = inquirer.createPromptModule(asPromptStreams(scriptedInput, capturedOutput))

  try {
    const sessionPromise = beginSession()
    // Attached before the first await so a rejection during the script cannot become an unhandled one.
    // Typed as the union rather than inferred per-branch, so `waitForText` can read `error` off it without
    // narrowing — the whole point of passing it there is to report a failure instead of timing out on one.
    const settled: Promise<{ result?: TResult; error?: unknown }> = sessionPromise.then(
      (result) => ({ result }),
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
 * Runs the generator's prompts against scripted input and returns the answers plus what was displayed.
 *
 * Stops at the answers. What the CLI does with them afterwards is `driveCommandLine`'s subject.
 */
export async function drivePrompts(script: readonly ScriptedResponse[]): Promise<DriveResult> {
  const plop = await nodePlop(resolvePlopfilePath())
  // The second declaration mismatch (see `asPromptStreams`): node-plop exposes `inquirer` at runtime as a
  // documented passthrough (`node-plop`'s `plopfileApi` literal) but omits it from `NodePlopAPI`.
  const plopWithInquirer = plop as unknown as { readonly inquirer: unknown }
  // ASSERTED, not assumed. The core patches the inquirer MODULE; this generator's runner reads whatever
  // `plop.inquirer` is. They are the same object today, and if that ever stops being true the prompts
  // would render to the real stdout while this harness waited for text that never arrives — a five-second
  // timeout with a misleading message. Failing here instead names the actual cause.
  if (plopWithInquirer.inquirer !== inquirer) {
    throw new Error('node-plop no longer shares the inquirer module, so patching it cannot reach the prompts')
  }

  const { result, error, screenText } = await runScriptedSession(
    script,
    // ANNOTATED, not cast. `runPrompts` is declared `Promise<any>`, so this narrows rather than
    // suppresses — without it every answer downstream would be `any`. `cli.ts` does the same thing the
    // same way, for the same reason.
    (): Promise<Record<string, unknown>> => plop.getGenerator(GENERATOR_NAME).runPrompts(),
  )
  return { answers: result, error, screenText }
}

/**
 * Runs the whole CLI against scripted input — prompts answered, then everything `runGenerate` does next.
 *
 * THE PATCHES THIS ADDS, both module-global and both restored in the `finally`:
 *
 *   - `process.stdin.isTTY`, because `runGenerate` refuses a non-TTY stdin before reaching a prompt. This
 *     is the guard that made the second half of that function unreachable from any suite.
 *   - `process.stdout.write` / `process.stderr.write`, because `cli.ts` writes its change log, its "Done.",
 *     its failure lines and its cancellation report straight to the process streams rather than to
 *     anything injectable. Capturing at that seam was chosen over adding stream parameters to
 *     `runCommandLine`: #42 rejected changing a shipped code path to observe it, and that reasoning holds.
 */
export async function driveCommandLine(script: readonly ScriptedResponse[]): Promise<CommandLineResult> {
  const restoreStdin = presentStdinAsTerminal()
  const processOutput = captureProcessOutput()
  try {
    const { result, error, screenText } = await runScriptedSession(script, () => runCommandLine([GENERATOR_NAME]))
    return { exitCode: result, error, printedText: processOutput.text(), screenText }
  } finally {
    processOutput.restore()
    restoreStdin()
  }
}

/**
 * Waits until the rendered text contains `awaitText`, or the run ends first.
 *
 * Racing against the run matters: a Ctrl-C script ends the prompts early, and without this the next wait
 * would block for the full timeout before reporting a confusing miss instead of the real outcome.
 */
async function waitForText(
  readScreenText: () => string,
  awaitText: string,
  runEnded: Promise<{ readonly error?: unknown }>,
): Promise<void> {
  const deadline = Date.now() + PROMPT_APPEARANCE_TIMEOUT_MS
  let endedWith: { readonly error?: unknown } | undefined
  void runEnded.then((outcome) => {
    endedWith = outcome
  })

  while (Date.now() < deadline) {
    if (readScreenText().includes(awaitText)) {
      return
    }
    if (endedWith !== undefined) {
      // The run finished before this question appeared. If it finished by REJECTING, that error is the
      // real story and returning quietly would bury it — the caller then sees only a downstream assertion
      // about a missing answer, with the cause discarded.
      if (endedWith.error !== undefined) {
        throw new Error(
          `the prompt session failed while waiting for ${JSON.stringify(awaitText)}: ${String(endedWith.error)}`,
        )
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, PROMPT_POLL_INTERVAL_MS))
  }

  throw new Error(
    `the prompt never displayed ${JSON.stringify(awaitText)} within ${PROMPT_APPEARANCE_TIMEOUT_MS}ms.\n` +
      `What it displayed instead:\n${readScreenText()}`,
  )
}
