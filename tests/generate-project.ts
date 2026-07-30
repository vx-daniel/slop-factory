import { spawnSync } from 'node:child_process'
import path from 'node:path'
import nodePlop from 'node-plop'
import { resolvePlopfilePath } from '../plopfile-path.js'
import type { PackageManager, ProjectStructure, TestRunner } from '../modules/module-contract.js'

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
  /**
   * Defaults to `single`, matching what the prompts can produce.
   *
   * Supplying `monorepo` here is currently the ONLY way to reach that layout — `toProjectAnswers` forces
   * `single` for anything coming from a prompt, because the per-module template changes that make a
   * generated workspace build are not in place yet. So this parameter is what keeps the package-root
   * plumbing exercised rather than merely written.
   */
  readonly projectStructure?: ProjectStructure
  /** Defaults to `core`. Only meaningful under `monorepo`. */
  readonly firstPackageName?: string
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
    packageManager: request.packageManager,
    testRunner: request.testRunner,
    // Passed through only when supplied, so an unset value takes the same path a prompt-driven run does
    // rather than a test-only one. `toProjectAnswers` applies the defaults.
    ...(request.projectStructure === undefined
      ? {}
      : { projectStructure: request.projectStructure }),
    ...(request.firstPackageName === undefined
      ? {}
      : { firstPackageName: request.firstPackageName }),
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
