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
 * Exported for `tests/cli.test.ts` only — nothing else calls it. A predicate over three error shapes it
 * cannot produce itself is exactly the thing worth checking directly, and reaching it through a real
 * Ctrl-C would need a pseudo-terminal (see #44).
 *
 * Inquirer signals this three different ways depending on how the session ended, and none of them is a
 * defect worth a stack trace: Ctrl-C rejects with an `ExitPromptError`, a closed stdin surfaces as
 * `ERR_USE_AFTER_CLOSE` from readline, and a force-close reports "User force closed the prompt".
 * Without this, quitting the generator prints a Node crash dump — which reads as a broken tool rather
 * than as the thing the user just asked for.
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

async function runGenerate(): Promise<number> {
  // `generate` is interactive by design — every answer comes from a prompt, and there are no flags to
  // supply them non-interactively. Without a terminal, inquirer renders the first question, hits EOF,
  // and force-closes from inside a signal handler; the resulting ERR_USE_AFTER_CLOSE surfaces as a Node
  // crash dump that no try/catch around `runPrompts` can intercept, because it is thrown during exit
  // rather than from the promise. Refusing up front turns that into one legible sentence.
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
  // why the interruption path below can simply report and exit with nothing to clean up.
  let answers: Record<string, unknown>
  try {
    answers = await generator.runPrompts()
  } catch (error) {
    if (isPromptInterruption(error)) {
      process.stderr.write('\nCancelled — nothing was written.\n')
      return EXIT_CODE_INTERRUPTED
    }
    throw error
  }

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
