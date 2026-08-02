import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import nodePlop from 'node-plop'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { INTERRUPTED, isPromptInterruption, listenForInterruption } from '../cli.js'
import { resolvePlopfilePath } from '../plopfile-path.js'
import { type CommandResult, runCommand } from './generate-project.js'

/**
 * Runs the CLI the way an operator does, and asserts what it prints and what it exits with.
 *
 * NOTHING IN THIS REPOSITORY USED TO EXECUTE THE CLI AT ALL. `tests/packaging.test.ts` asserts that
 * `bin/slop-factory.mjs` and `dist/cli.js` are present in the tarball; no suite ran either. `runCommandLine`
 * was exported with zero coverage and `isPromptInterruption` was not exported at all — and the cost of that
 * was not hypothetical: `--help` described a "runtime" prompt that does not exist, called the destination
 * prompt a directory browser that had been removed, and never mentioned the layout or package-names
 * questions. See #42.
 *
 * THROUGH THE REAL BINARY, NOT THE EXPORTED FUNCTION. Every dispatch case here spawns
 * `bin/slop-factory.mjs`, which is what npm installs and what `npx slop-factory` runs. #42 proposed
 * injecting output streams into `runCommandLine` so its printing could be captured in-process; that turned
 * out to be unnecessary, and a subprocess is the better test anyway — it covers the shebang, the bin's own
 * missing-build branch, the exit code as the shell sees it, and which stream each message went to. Changing
 * a shipped code path to observe it, when spawning observes more of it, is a trade with no upside.
 *
 * TWO THINGS ARE REACHED DIRECTLY RATHER THAN THROUGH THE BINARY, for different reasons.
 *
 * `listenForInterruption` is given a REAL SIGINT, raised in this process. No pseudo-terminal is involved,
 * and an earlier version of this comment claiming one was required was wrong: Vitest's default pool is
 * `forks`, so the worker is a child with no SIGINT listener of its own, and inquirer signals `process.pid`
 * rather than the process group. This is the only automated coverage the interruption fix has (#50).
 *
 * `isPromptInterruption` is a pure predicate, tested against hand-built error shapes. That is deliberately
 * NOT a reachability claim — two of the three shapes cannot occur with the installed inquirer at all, which
 * `cli.ts` sets out in full. Ctrl-C never reaches this predicate; it raises a signal.
 */

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')
const BINARY_RELATIVE_PATH = path.join('bin', 'slop-factory.mjs')

const EXIT_SUCCESS = 0
const EXIT_FAILURE = 1

/** Runs the published binary with the given arguments, from the factory root. */
function runBinary(...commandLineArguments: readonly string[]): CommandResult {
  return runCommand({
    command: 'node',
    commandArguments: [BINARY_RELATIVE_PATH, ...commandLineArguments],
    workingDirectory: FACTORY_ROOT,
  })
}

/**
 * The phrase `--help` must contain for each prompt the generator declares.
 *
 * THIS TABLE IS THE GUARD, not documentation of one. The test iterates the generator's ACTUAL prompt list
 * and requires an entry here for every name it finds, so adding or renaming a prompt fails until someone
 * decides how the usage text should describe it — which is the moment they will notice the text needs
 * updating. That is the drift this exists to stop, and it is the drift that already happened.
 *
 * Prose phrases rather than prompt names, because `--help` is written for an operator and must not say
 * `projectStructure` at them. Substring matching against prose is normally the trap
 * `.claude/rules/asserting-on-file-content.md` warns about — here it is correct, and this is the exception
 * that proves the rule's shape: the file under assertion has no data to match, because describing the
 * prompts in prose IS its entire job.
 *
 * MUTATION EVIDENCE, of two kinds. These assertions were written BEFORE the usage text was fixed and ran
 * red against the real defect — "does not describe the projectStructure prompt" and "still mentions
 * 'a runtime', which no prompt produces" — so the bug they exist for is one they have actually caught.
 * Separately, renaming `projectStructure` to `projectLayout` in `plopfile.ts` fails both this table's
 * exactly-matches assertion and the describes-every-prompt loop, which is the future drift they guard.
 */
const USAGE_PHRASE_BY_PROMPT_NAME: Readonly<Record<string, string>> = {
  projectName: 'project name',
  projectPath: 'destination directory',
  projectStructure: 'layout',
  packageNames: 'package names',
  packageManager: 'package manager',
  testRunner: 'test runner',
  enableFeatures: 'optional features',
}

/** Every prompt name the generator declares, read from the built plopfile rather than restated. */
async function loadDeclaredPromptNames(): Promise<readonly string[]> {
  const plop = await nodePlop(resolvePlopfilePath())
  const prompts = plop.getGenerator('generate').prompts as ReadonlyArray<{ name?: string }>
  return prompts.map((prompt) => prompt.name).filter((promptName): promptName is string => promptName !== undefined)
}

describe('the arguments that print usage', () => {
  // All four spellings, because each is a separate branch in `runCommandLine` and a dropped one fails
  // only for whoever happened to type that form.
  const USAGE_ARGUMENTS: readonly (readonly string[])[] = [[], ['--help'], ['-h'], ['help']]

  it.each(USAGE_ARGUMENTS)('prints usage to stdout and exits 0 for %j', (...commandLineArguments) => {
    const result = runBinary(...commandLineArguments)

    expect(result.exitCode, result.output).toBe(EXIT_SUCCESS)
    expect(result.standardOutput).toContain('Usage:')
    // On stdout, NOT stderr. Usage requested is not an error, and a CLI that prints it to stderr breaks
    // `slop-factory --help | less` for the person most likely to try that.
    expect(result.standardError).toBe('')
  })
})

describe('--version', () => {
  it.each([['--version'], ['-v']])('prints the manifest version and exits 0 for %s', async (versionArgument) => {
    const manifest = JSON.parse(await readFile(path.join(FACTORY_ROOT, 'package.json'), 'utf8')) as {
      version: string
    }
    const result = runBinary(versionArgument)

    expect(result.exitCode, result.output).toBe(EXIT_SUCCESS)
    // Compared against the manifest rather than a literal, so a release bump does not fail this test —
    // and so a `readPackageVersion` that silently returned its `'unknown'` fallback would.
    expect(result.standardOutput.trim()).toBe(manifest.version)
    expect(result.standardError).toBe('')
  })
})

describe('an unknown command', () => {
  it('names what it did not understand, on stderr, and exits 1', () => {
    const result = runBinary('genrate')

    expect(result.exitCode).toBe(EXIT_FAILURE)
    // Echoing the argument back matters: the most common cause is a typo, and a bare "unknown command"
    // leaves the operator re-reading what they typed.
    expect(result.standardError).toContain('genrate')
    expect(result.standardError).toContain('Usage:')
    expect(result.standardOutput).toBe('')
  })
})

describe('the usage text and the prompt list cannot drift apart', () => {
  let usageText: string
  let declaredPromptNames: readonly string[]

  beforeAll(async () => {
    usageText = runBinary('--help').standardOutput
    declaredPromptNames = await loadDeclaredPromptNames()
  })

  it('has a usage phrase for exactly the prompts that exist', () => {
    // Both directions in one assertion. A prompt added without a phrase is undescribed; a phrase left
    // behind by a removed prompt means the usage text still advertises a question nobody is asked — which
    // is precisely the state this file was written to fix.
    expect([...Object.keys(USAGE_PHRASE_BY_PROMPT_NAME)].sort()).toEqual([...declaredPromptNames].sort())
  })

  it('describes every prompt the generator declares', () => {
    for (const promptName of declaredPromptNames) {
      const expectedPhrase = USAGE_PHRASE_BY_PROMPT_NAME[promptName]
      // Checked before use, so an unmapped prompt says so instead of reporting that the usage text does
      // not contain `undefined`. Adding a prompt is the likeliest way to reach this, and the person who
      // just did it should be told what to do rather than shown a puzzle.
      expect(
        expectedPhrase,
        `no usage phrase is defined for the "${promptName}" prompt — add one to USAGE_PHRASE_BY_PROMPT_NAME ` +
          "and make sure the CLI's USAGE text actually says it",
      ).toBeDefined()
      expect(
        usageText,
        `--help does not describe the "${promptName}" prompt — it should mention "${expectedPhrase}"`,
      ).toContain(expectedPhrase)
    }
  })

  it('advertises no prompt that was removed', () => {
    // Named individually rather than derived, because a removed prompt leaves nothing to derive FROM.
    // Each of these was in the usage text while the prompt it named did not exist.
    for (const removedVocabulary of ['a runtime', 'browsed from']) {
      expect(usageText, `--help still mentions "${removedVocabulary}", which no prompt produces`).not.toContain(
        removedVocabulary,
      )
    }
  })
})

describe('generate without an interactive terminal', () => {
  it('refuses, explains why, and exits 1', () => {
    // spawnSync gives the child a PIPE for stdin, so `process.stdin.isTTY` is undefined — the same thing
    // that happens in CI or behind a pipe. Without the guard in `runGenerate`, inquirer renders the first
    // question, hits EOF and force-closes from inside a signal handler, and the operator gets a Node crash
    // dump instead of a sentence.
    const result = runBinary('generate')

    expect(result.exitCode).toBe(EXIT_FAILURE)
    expect(result.standardError).toContain('interactive terminal')
    // The refusal must say the limitation is the tool's, not the operator's mistake — and point somewhere.
    expect(result.standardError).toContain('non-interactive')
    expect(result.standardOutput).toBe('')
  })
})

describe('the binary without a build', () => {
  let unbuiltDirectory: string

  beforeAll(async () => {
    // The bin resolves `../dist/cli.js` relative to ITSELF, so copying it alone into an empty tree
    // reproduces a fresh clone that has not run `npm run build`.
    unbuiltDirectory = await mkdtemp(path.join(os.tmpdir(), 'slop-factory-unbuilt-'))
    await mkdir(path.join(unbuiltDirectory, 'bin'), { recursive: true })
    await copyFile(path.join(FACTORY_ROOT, BINARY_RELATIVE_PATH), path.join(unbuiltDirectory, BINARY_RELATIVE_PATH))
  })

  afterAll(async () => {
    await rm(unbuiltDirectory, { recursive: true, force: true })
  })

  it('tells a cloner to build rather than failing on a missing module', () => {
    const result = runCommand({
      command: 'node',
      commandArguments: [BINARY_RELATIVE_PATH, '--help'],
      workingDirectory: unbuiltDirectory,
    })

    expect(result.exitCode).toBe(EXIT_FAILURE)
    expect(result.standardError).toContain('npm run build')
    // A bare ERR_MODULE_NOT_FOUND naming an internal path is the failure this branch exists to replace.
    expect(result.standardError).not.toContain('ERR_MODULE_NOT_FOUND')
  })
})

describe('listenForInterruption', () => {
  /**
   * THE ANCHOR FOR THE SIGINT FIX (#50), and the only automated coverage the production interruption code
   * has. Without it the fix rests entirely on a by-hand pseudo-terminal run recorded in commit prose, which
   * this repository's own standard — a guard is not done until you have watched it fail — does not accept.
   *
   * A REAL SIGNAL, raised in-process, which an earlier version of this work claimed was impossible because
   * Vitest would treat SIGINT as "cancel the run". That was wrong, and measured wrong: the default pool is
   * `forks`, so this worker is a child process carrying zero SIGINT listeners of its own, and inquirer
   * targets `process.pid` rather than the process group. A worker-local handler competes with nothing.
   *
   * What killed the worker in the earlier attempt was sending Ctrl-C THROUGH inquirer with nothing
   * listening — which is the bug, not a property of the runner. Installing the listener is what stops it.
   *
   * MUTATION EVIDENCE, and one honest gap:
   *   • deleting `process.once('SIGINT', …)` fails the run — as "Worker exited unexpectedly" rather than an
   *     assertion, because the unhandled signal kills the worker. That IS the pre-fix behaviour, reproduced.
   *   • gutting `stop()` fails the second test by name.
   *   • replacing the keep-alive interval with a one-shot does NOT fail either test, and cannot: in a Vitest
   *     worker the event loop is busy, so the loop-empties race the timer exists for never happens. That
   *     part of the fix is covered only by the by-hand pseudo-terminal runs recorded on #50. An end-to-end
   *     anchor would close it; `script(1)` is util-linux and would make the suite Linux-only, which #51 is
   *     open about not wanting to deepen.
   */
  const SIGNAL_DELIVERY_TIMEOUT_MS = 1000

  it('resolves when a real SIGINT arrives, and leaves the process running', async () => {
    const listenersBefore = process.listenerCount('SIGINT')
    const interruption = listenForInterruption()

    try {
      process.kill(process.pid, 'SIGINT')

      const outcome = await Promise.race([
        interruption.interrupted,
        new Promise((resolve) => setTimeout(() => resolve('never delivered'), SIGNAL_DELIVERY_TIMEOUT_MS)),
      ])

      expect(outcome, 'the signal was raised but the listener never saw it').toBe(INTERRUPTED)
    } finally {
      interruption.stop()
    }

    // Survival is half the claim: before the fix this exact signal terminated the process outright.
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore)
  })

  it('removes its listener when stopped without ever being signalled', async () => {
    // THE CASE THAT MAKES THE CLEANUP ASSERTION REAL. `process.once` removes itself after firing, so the
    // test above would pass with `stop()` gutted entirely — its listener count returns to baseline either
    // way. Only a session that is never signalled can tell `stop()` from nothing at all.
    const listenersBefore = process.listenerCount('SIGINT')
    const interruption = listenForInterruption()
    expect(process.listenerCount('SIGINT'), 'the listener was never installed').toBe(listenersBefore + 1)

    interruption.stop()

    expect(process.listenerCount('SIGINT'), 'stop() left its SIGINT listener behind').toBe(listenersBefore)
  })
})

describe('isPromptInterruption', () => {
  // THE PREDICATE'S LOGIC, against hand-built shapes — not proof that any of them is reachable, and the
  // difference matters. Two of the three cannot occur with the installed inquirer 9.3.8: `ExitPromptError`
  // and "User force closed" are `@inquirer/core` 10.x constructs, and neither string appears anywhere in
  // `node_modules`. They are matched as forward compatibility for an upgrade, which `cli.ts` states.
  //
  // Only `ERR_USE_AFTER_CLOSE` — a Node readline error — is live today. Ctrl-C never reaches this predicate
  // at all; it raises a signal, which `listenForInterruption` above is for.
  it('recognises a Ctrl-C ExitPromptError', () => {
    const exitPromptError = Object.assign(new Error('User force closed the prompt'), { name: 'ExitPromptError' })
    expect(isPromptInterruption(exitPromptError)).toBe(true)
  })

  it('recognises a closed stdin', () => {
    expect(isPromptInterruption(Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' }))).toBe(
      true,
    )
  })

  it('recognises a force close by message alone', () => {
    // No `name`, no `code` — the shape that reaches the message check.
    expect(isPromptInterruption({ message: 'User force closed the prompt with 0 null' })).toBe(true)
  })

  it('does not swallow a real failure', () => {
    // The direction that matters most. Treating a genuine error as an abandoned session would exit 130
    // with "Cancelled — nothing was written." and no stack trace, hiding a real defect behind a message
    // saying everything is fine.
    expect(isPromptInterruption(new Error('ENOSPC: no space left on device'))).toBe(false)
    expect(isPromptInterruption(new TypeError('answers is not iterable'))).toBe(false)
  })

  it('handles values that are not errors at all', () => {
    for (const notAnError of [null, undefined, 'a string', 42]) {
      expect(isPromptInterruption(notAnError), `${String(notAnError)} should not read as an interruption`).toBe(false)
    }
  })
})
