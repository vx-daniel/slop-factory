import { spawnSync } from 'node:child_process'
import path from 'node:path'
import nodePlop from 'node-plop'
import { resolvePlopfilePath } from '../plopfile-path.js'
import type { ProjectRuntime, TestRunner } from '../modules/module-contract.js'

/**
 * Resolved at MODULE LOAD, not per call — so importing this helper throws if the factory has not been
 * built. That is deliberate: `resolvePlopfilePath` only ever returns the compiled plopfile, and failing
 * at import gives a message naming the missing build instead of a confusing failure mid-generation.
 * Every npm script that reaches this module runs `npm run build` first.
 */
const PLOPFILE_PATH = resolvePlopfilePath()
const GENERATOR_NAME = 'generate'

export interface GenerationRequest {
  readonly projectName: string
  readonly workspaceDirectory: string
  readonly projectRuntime: ProjectRuntime
  readonly testRunner: TestRunner
  readonly enableFeatures: readonly string[]
}

export interface CommandResult {
  readonly succeeded: boolean
  readonly output: string
}

/**
 * Runs the generator with fixed answers, bypassing the interactive prompts.
 *
 * Driven through node-plop's programmatic API rather than the `plop` CLI because the CLI's positional
 * bypass cannot express "no checkboxes selected" — it falls through to prompting, and with no TTY that
 * throws `ERR_USE_AFTER_CLOSE`. The no-features case is precisely the one worth testing, so the
 * harness has to be able to express it.
 */
export async function generateProject(request: GenerationRequest): Promise<string> {
  const plop = await nodePlop(PLOPFILE_PATH)
  const generator = plop.getGenerator(GENERATOR_NAME)

  const result = await generator.runActions({
    projectName: request.projectName,
    projectPath: request.workspaceDirectory,
    projectRuntime: request.projectRuntime,
    testRunner: request.testRunner,
    enableFeatures: [...request.enableFeatures],
  })

  if (result.failures.length > 0) {
    const described = result.failures
      .map((failure) => `${failure.type}: ${failure.error ?? failure.path}`)
      .join('\n')
    throw new Error(`generation failed:\n${described}`)
  }

  return path.join(request.workspaceDirectory, request.projectName)
}

/** Runs a command in a directory, capturing combined output for failure messages. */
export function runCommand(options: {
  readonly command: string
  readonly commandArguments: readonly string[]
  readonly workingDirectory: string
}): CommandResult {
  const result = spawnSync(options.command, [...options.commandArguments], {
    cwd: options.workingDirectory,
    encoding: 'utf8',
  })
  return {
    succeeded: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

/**
 * Whether to leave generated trees on disk instead of cleaning up, for inspecting a failure.
 *
 * Read HERE rather than in the test file on purpose. `node/no-process-env` is an error in `*.test.ts` —
 * a test reaching for `process.env` couples to ambient state that dependency injection exists to avoid —
 * but this harness module is the composition root, which is exactly where the convention says a single
 * env read belongs.
 */
export const shouldKeepGeneratedTrees = process.env.KEEP_GENERATED_TREES !== undefined

/** Whether a runtime's binary is on PATH, so an absent Bun is skipped rather than failed. */
export function isRuntimeAvailable(runtime: ProjectRuntime): boolean {
  return spawnSync(runtime, ['--version'], { stdio: 'ignore' }).status === 0
}

/**
 * True when git would ignore the path in this tree.
 *
 * Asked of git rather than derived by reading `.gitignore`, because the rules that matter here are
 * ORDER-sensitive: `config.*.toml` followed by `!config.defaults.toml` only commits the defaults
 * because git applies the LAST matching rule. Reordering those two lines silently stops committing the
 * one config file that must be committed, and no amount of grepping the file catches it.
 */
export function isIgnoredByGit(options: {
  readonly filePath: string
  readonly workingDirectory: string
}): boolean {
  return (
    spawnSync('git', ['check-ignore', '--quiet', options.filePath], {
      cwd: options.workingDirectory,
    }).status === 0
  )
}
