import { spawnSync } from 'node:child_process'
import path from 'node:path'
import nodePlop from 'node-plop'
import type { PackageManager, ProjectStructure, TestRunner } from '../modules/module-contract.js'
import { resolvePlopfilePath } from '../plopfile-path.js'

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
  readonly packageManager: PackageManager
  readonly testRunner: TestRunner
  /** Defaults to `single`, matching the generator's own default when no answer is supplied. */
  readonly projectStructure?: ProjectStructure
  /**
   * Defaults to `['core']`. Only meaningful under `monorepo`.
   *
   * An ARRAY, not the comma-separated string the prompt produces — `normalizePackageNames` accepts both,
   * and a caller holding a list should not have to join it only for the generator to split it again.
   */
  readonly packageNames?: readonly string[]
  readonly enableFeatures: readonly string[]
}

export interface CommandResult {
  readonly succeeded: boolean
  /**
   * Both streams, concatenated. What almost every caller wants: a failure message to paste into an
   * assertion, where which stream carried it is noise.
   */
  readonly output: string
  /**
   * The streams kept apart, for the callers that are asserting about the streams THEMSELVES.
   *
   * `tests/cli.test.ts` is the reason they exist: a CLI printing its usage to stdout on `--help` and to
   * stderr on an unknown command is the behaviour under test, and `output` cannot tell those apart —
   * both spellings of the bug produce identical combined text.
   */
  readonly standardOutput: string
  readonly standardError: string
  /** Exit code, or `null` if the process was killed by a signal. Distinguishes 1 from 130. */
  readonly exitCode: number | null
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
    packageManager: request.packageManager,
    testRunner: request.testRunner,
    // Passed through only when supplied, so an unset value takes the same path a prompt-driven run does
    // rather than a test-only one. `toProjectAnswers` applies the defaults.
    ...(request.projectStructure === undefined ? {} : { projectStructure: request.projectStructure }),
    ...(request.packageNames === undefined ? {} : { packageNames: [...request.packageNames] }),
    enableFeatures: [...request.enableFeatures],
  })

  if (result.failures.length > 0) {
    const described = result.failures.map((failure) => `${failure.type}: ${failure.error ?? failure.path}`).join('\n')
    throw new Error(`generation failed:\n${described}`)
  }

  return path.join(request.workspaceDirectory, request.projectName)
}

/** Runs a command in a directory, capturing its output for assertions and failure messages. */
export function runCommand(options: {
  readonly command: string
  readonly commandArguments: readonly string[]
  readonly workingDirectory: string
}): CommandResult {
  const result = spawnSync(options.command, [...options.commandArguments], {
    cwd: options.workingDirectory,
    encoding: 'utf8',
  })
  const standardOutput = result.stdout ?? ''
  const standardError = result.stderr ?? ''

  return {
    succeeded: result.status === 0,
    output: `${standardOutput}${standardError}`,
    standardOutput,
    standardError,
    exitCode: result.status,
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

/**
 * Whether a package manager's binary is on PATH, so an absent one is skipped rather than failed.
 *
 * The binary probed is the MANAGER itself — npm, pnpm or bun — not the runtime it implies. A machine
 * without pnpm should report SKIP for the pnpm combinations rather than a broken factory.
 *
 * Read the skips when interpreting a green run: a suite where every pnpm combination skipped has not
 * verified pnpm, it has declined to. `npm run verify` on a machine missing a manager is a weaker receipt
 * than it looks.
 */
export function isPackageManagerAvailable(packageManager: PackageManager): boolean {
  return spawnSync(packageManager, ['--version'], { stdio: 'ignore' }).status === 0
}

/**
 * True when git would ignore the path in this tree.
 *
 * Asked of git rather than derived by reading `.gitignore`, because the rules that matter here are
 * ORDER-sensitive: `config.*.toml` followed by `!config.defaults.toml` only commits the defaults
 * because git applies the LAST matching rule. Reordering those two lines silently stops committing the
 * one config file that must be committed, and no amount of grepping the file catches it.
 */
export function isIgnoredByGit(options: { readonly filePath: string; readonly workingDirectory: string }): boolean {
  return (
    spawnSync('git', ['check-ignore', '--quiet', options.filePath], {
      cwd: options.workingDirectory,
    }).status === 0
  )
}
