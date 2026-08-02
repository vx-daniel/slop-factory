import nodePlop from 'node-plop'
import { resolvePlopfilePath } from './plopfile-path.js'

/**
 * The `slop-factory` command line entry point.
 *
 * Driven through node-plop's programmatic API rather than shelling out to the `plop` CLI, for two
 * reasons. It keeps `plop` out of the runtime dependencies — only `node-plop` is needed — and it means
 * the published command and the test suite exercise the SAME code path, which a spawned binary would
 * not.
 */

/** The generator in plopfile.ts that `slop-factory generate` runs. Same name on purpose. */
const GENERATE_COMMAND = 'generate'

const EXIT_CODE_FAILURE = 1

/** Conventional exit code for "terminated by SIGINT" (128 + 2), which Ctrl-C at a prompt is. */
const EXIT_CODE_INTERRUPTED = 130

/**
 * Whether an error means the operator abandoned the prompts rather than something going wrong.
 *
 * ONLY ONE OF THESE THREE SHAPES IS REACHABLE TODAY, and saying otherwise was wrong. `ExitPromptError` and
 * "User force closed the prompt" are `@inquirer/core` 10.x constructs; the installed inquirer is 9.3.8 and
 * neither string appears anywhere in `node_modules`. Worse, 9.3.8 does not reject on Ctrl-C at all — its
 * force-close handler closes the readline and raises SIGINT, so nothing ever settles. That is precisely why
 * `listenForInterruption` exists, and why the `catch` in `runGenerate` is NOT the Ctrl-C path.
 *
 * What remains live is `ERR_USE_AFTER_CLOSE`, a Node readline error rather than an inquirer one, reachable
 * when stdin closes under a running prompt — a terminal window shut mid-session. Without this predicate that
 * surfaces as a crash dump, which reads as a broken tool rather than as the thing the operator just did.
 *
 * The other two are kept deliberately, as a cheap forward-compatible match for the day this upgrades to the
 * `@inquirer/*` family. That is speculative by definition; it is two string comparisons, and the alternative
 * is a silent regression at upgrade time. Stated so nobody reads them as evidence of current behaviour.
 *
 * Exported for `tests/cli.test.ts`, which tests the PREDICATE'S LOGIC against hand-built shapes — not a
 * reachable path, and the tests say so.
 */
export function isPromptInterruption(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const { name, code, message } = error as { name?: string; code?: string; message?: string }
  return name === 'ExitPromptError' || code === 'ERR_USE_AFTER_CLOSE' || (message ?? '').includes('User force closed')
}

const USAGE = `slop-factory — assemble a new TypeScript project from composable modules

Usage:
  npx slop-factory generate     Generate a project (prompts for the details)
  npx slop-factory --help       Show this message
  npx slop-factory --version    Print the version

The generator asks for a project name, a destination directory (defaults to the one you are in), the
layout — a single package, or a workspace — the package names to create under packages/ if you chose a
workspace, a package manager, a test runner (asked only for bun), and any optional features.

Nothing is written until every question is answered, and it refuses to generate into a directory that
is not empty.
`

/**
 * Reads the version out of the package's own manifest, so it cannot drift from what was published.
 *
 * ONE path, not two. This previously tried `./package.json` first and fell back to `../package.json`,
 * with the fallback commented as "the published layout". Both layouts are the same layout: this file is
 * only ever reached as `dist/cli.js` — `bin/slop-factory.mjs` resolves exactly that path, `files` ships
 * `bin` and `dist`, and the manifest declares no `main` or `exports` for anything else to import. So
 * `dist/package.json` never exists in either the working tree or the tarball, the first read always threw
 * ENOENT, and the fallback always ran. A `try` whose body cannot succeed reads as handling a case that
 * does not exist.
 */
async function readPackageVersion(): Promise<string> {
  // Relative to `dist/cli.js`, so one level up is the package root.
  const manifestUrl = new URL('../package.json', import.meta.url)
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as { version?: string }
  return manifest.version ?? 'unknown'
}

/**
 * Reports an abandoned session and yields the exit code for it.
 *
 * One function because there are two ways in — a signal and a rejection — and they must be
 * indistinguishable to the operator. Two copies of the message drifted apart the moment one was reworded.
 */
function reportCancelled(): number {
  process.stderr.write('\nCancelled — nothing was written.\n')
  return EXIT_CODE_INTERRUPTED
}

/** How often the keep-alive timer wakes while waiting for an interruption, in milliseconds. */
const KEEP_ALIVE_INTERVAL_MS = 250

/** Distinguishes "the operator interrupted" from any answer set, in the race below. */
export const INTERRUPTED = Symbol('interrupted')

/**
 * Listens for the SIGINT a Ctrl-C at a prompt produces, until told to stop.
 *
 * WHY THIS IS NEEDED AT ALL, measured with a pseudo-terminal (#50). inquirer's force-close handler ends
 * with `process.kill(process.pid, 'SIGINT')` (`inquirer/lib/ui/baseUI.js`). With no listener for that
 * signal, Node's default action terminates the process outright: `runPrompts` never settles, the `catch`
 * below never runs, and "Cancelled — nothing was written." was never printed. Three runs of three, killed
 * by signal 2 with exit code 0.
 *
 * That went unnoticed because a shell reports 130 for a signal-2 death — the same number
 * `EXIT_CODE_INTERRUPTED` holds. `echo $?` looked exactly right for the wrong reason, and the only symptom
 * was a message that was not there.
 *
 * `once`, not `on`, so the CLI stays killable: a second Ctrl-C finds no listener and gets Node's default
 * action. The first one is handled; holding the signal after that would be a bug of its own.
 *
 * EXPORTED so `tests/cli.test.ts` can raise a real SIGINT at it. That is possible because Vitest's default
 * pool here is `forks`: the worker is a child process with no SIGINT listener of its own (measured — pid
 * differs from ppid, listener count 0), and inquirer targets `process.pid` rather than the group, so a
 * worker-local handler competes with nothing. An earlier comment claimed the opposite and was wrong.
 */
export function listenForInterruption(): {
  readonly interrupted: Promise<typeof INTERRUPTED>
  stop: () => void
} {
  // Assigned synchronously by the executor below, before the promise is returned. The placeholder exists
  // only so the binding needs no definite-assignment assertion.
  let reportInterrupted: (interrupted: typeof INTERRUPTED) => void = () => undefined
  const interrupted = new Promise<typeof INTERRUPTED>((resolve) => {
    reportInterrupted = resolve
  })

  const onInterrupt = (): void => {
    reportInterrupted(INTERRUPTED)
  }
  process.once('SIGINT', onInterrupt)

  /**
   * Holds the event loop open while the interruption is delivered, and nothing else.
   *
   * MEASURED, and the reason this fix did not work without it. A JS listener changes SIGINT from an
   * immediate kernel-level termination into an event QUEUED on the loop — but inquirer's force-close
   * closes the readline and pauses stdin BEFORE raising it, so by then the loop has nothing left to run.
   * Node sees an empty loop with a pending top-level await and exits 13 instead of delivering the signal:
   * handler never called, message never printed, three runs of three.
   *
   * An INTERVAL, not a one-shot, and armed before the prompts rather than when the signal arrives — there
   * is no moment at which a timeout could be scheduled, because the code never learns the signal is coming.
   * It therefore stays armed for the whole session and is cleared in `stop()`, which runs in a `finally`,
   * so it can never hold the process open on any path. "Simplifying" it to a `setTimeout` restores the
   * exit-13 bug described above.
   */
  const keepLoopAliveForSignal = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS)

  return {
    interrupted,
    stop: (): void => {
      clearInterval(keepLoopAliveForSignal)
      process.removeListener('SIGINT', onInterrupt)
    },
  }
}

async function runGenerate(): Promise<number> {
  // `generate` is interactive by design — every answer comes from a prompt, and there are no flags to
  // supply them non-interactively. Without a terminal, inquirer renders the first question, hits EOF, and
  // force-closes; the resulting ERR_USE_AFTER_CLOSE is thrown during process exit rather than from the
  // promise, so it lands as a crash dump. Refusing up front turns that into one legible sentence.
  //
  // Not a contradiction of the `catch` further down, though it reads like one: that catch handles the same
  // error CODE arriving as a rejection while a prompt is live — a terminal closed mid-session — which is a
  // different moment with a different delivery. Neither one substitutes for the other.
  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      'slop-factory generate needs an interactive terminal — it asks questions and has no ' +
        'non-interactive flags yet.\n' +
        'If you reached this in CI or through a pipe, run it locally instead.\n',
    )
    return EXIT_CODE_FAILURE
  }

  const plop = await nodePlop(resolvePlopfilePath())
  const generator = plop.getGenerator(GENERATE_COMMAND)

  // runPrompts drives inquirer over the prompt list plopfile.ts declares — all of them stock `input`,
  // `list` and `checkbox`; no prompt type is registered. Answering is the only interactive part; nothing
  // is written until it resolves, so abandoning the questions leaves no partial project behind — which is
  // why both interruption paths below can simply report and exit with nothing to clean up.
  //
  // TWO PATHS, and it matters which is which because they are not interchangeable. Ctrl-C raises a SIGNAL
  // and never rejects on inquirer 9.3.8, so ONLY the listener sees it — the `catch` below is dead for
  // Ctrl-C. A stdin that closes under a live prompt instead REJECTS, which only the `catch` sees. Deleting
  // either as redundant silently restores #50, and the shell reports 130 either way, so nothing looks wrong.
  //
  // The listener is removed before the actions run. During generation "nothing was written" would be a
  // lie, and Ctrl-C there should keep its default meaning rather than print a false reassurance.
  const interruption = listenForInterruption()
  let outcome: Record<string, unknown> | typeof INTERRUPTED
  try {
    // No second `.catch` on the losing promise: `Promise.race` marks a rejection handled even when it
    // arrives after another entrant won, measured 3 of 3. A guard was here with a comment claiming
    // otherwise; it was removed rather than left as a true-looking falsehood.
    outcome = await Promise.race([generator.runPrompts(), interruption.interrupted])
  } catch (error) {
    if (isPromptInterruption(error)) {
      return reportCancelled()
    }
    throw error
  } finally {
    interruption.stop()
  }

  if (outcome === INTERRUPTED) {
    return reportCancelled()
  }
  const answers = outcome

  const results = await generator.runActions(answers)

  for (const change of results.changes) {
    process.stdout.write(`  ${change.type}: ${change.path}\n`)
  }
  for (const failure of results.failures) {
    process.stderr.write(`  FAILED ${failure.type}: ${failure.error ?? failure.path}\n`)
  }

  if (results.failures.length > 0) {
    return EXIT_CODE_FAILURE
  }

  process.stdout.write('\nDone. Next: install dependencies and run the gate.\n')
  return 0
}

export async function runCommandLine(commandLineArguments: readonly string[]): Promise<number> {
  const [command] = commandLineArguments

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE)
    return 0
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${await readPackageVersion()}\n`)
    return 0
  }

  if (command === GENERATE_COMMAND) {
    return await runGenerate()
  }

  process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`)
  return EXIT_CODE_FAILURE
}
