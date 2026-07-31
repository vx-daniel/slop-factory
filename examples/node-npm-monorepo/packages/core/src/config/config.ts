/**
 * Configuration loader — finds the TOML layers, deep-merges them, validates the result.
 *
 * Three layers, in precedence order (later wins):
 *   1. `config.defaults.toml`  committed, safe, complete. Every key the schema requires.
 *   2. `config.local.toml`     gitignored, machine-specific. Only the keys it changes.
 *   3. `.env`                  gitignored, SECRETS ONLY — never read into the config object.
 *
 * Layer 3 never enters the config tree. A service names an env var (`apiKeyEnv`) and the value is
 * read at point of use by {@link resolveServiceApiKey}. That is the whole reason layers 1 and 2 are
 * safe to commit and to share with a teammate.
 *
 * TWO DESIGN CHOICES WORTH KEEPING, both of which exist to make this file testable:
 *
 *   1. Loading is LAZY and INJECTABLE, not a module-init side effect. The tempting alternative —
 *      `export const config = loadConfig()` at module scope — means merely importing this file
 *      touches the filesystem, so every test of every module that transitively imports config needs
 *      real TOML on disk, and an invalid config throws at import time where the stack trace points
 *      at nothing useful.
 *   2. The environment is a PARAMETER, not a direct `process.env` read in the logic. Ambient global
 *      state cannot be varied per test without mutating it and racing every other test in the file.
 *      `process.env` is read in exactly one place — the default argument below.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { type Config, parseConfig, type ServiceDefinition } from './config-schema.js'

export type { Config, Environment, LogLevel, ServiceDefinition } from './config-schema.js'

const DEFAULTS_FILENAME = 'config.defaults.toml'
const LOCAL_FILENAME = 'config.local.toml'

/**
 * Escape hatch for deployments where the config does not sit above the working directory — a
 * container that mounts config at a fixed path, for instance. Checked before the upward walk.
 */
const CONFIG_DIR_ENV_VAR = 'APP_CONFIG_DIR'

/** Filesystem operations the loader needs. Injected so tests supply crafted content, not fixtures. */
export interface ConfigFileSystem {
  readonly fileExists: (path: string) => boolean
  readonly readFile: (path: string) => string
}

/** A read-only view of environment variables — `process.env` in production, a literal in tests. */
export type EnvironmentVariables = Readonly<Record<string, string | undefined>>

const REAL_FILE_SYSTEM: ConfigFileSystem = {
  fileExists: (path: string): boolean => existsSync(path),
  readFile: (path: string): string => readFileSync(path, 'utf8'),
}

/**
 * Deep-merge `override` onto `base`: plain objects merge key by key, everything else replaces.
 *
 * Arrays REPLACE rather than concatenate, and that is the intended semantic — a local config setting
 * `jobQueue = ["scratch"]` means "use exactly this chain", not "append to the default chain".
 * Concatenating would make it impossible to shorten a list locally.
 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(override)) {
      merged[key] = deepMerge(base[key], value)
    }
    return merged
  }
  return override
}

/** Plain object = mergeable. Arrays and null are values that replace wholesale, not shapes to merge. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Options for {@link findConfigDirectory}. All are test seams; production uses the defaults. */
export interface FindConfigDirectoryOptions {
  /** Where the upward walk begins (default: the current working directory). */
  readonly startDirectory?: string
  /** Filesystem access (default: real `node:fs`). */
  readonly fileSystem?: ConfigFileSystem
  /** Environment variables, consulted for `APP_CONFIG_DIR` (default: `process.env`). */
  readonly environment?: EnvironmentVariables
}

/**
 * Find the directory holding `config.defaults.toml` by walking UP from the start directory.
 *
 * Walking up (rather than trusting `process.cwd()` directly) is what makes the loader work when the
 * process is started from a subdirectory, and under test runners that change the working directory.
 * `APP_CONFIG_DIR` short-circuits the walk entirely.
 *
 * @throws Error naming the directory searched from and the env var that overrides the search.
 */
export function findConfigDirectory(options: FindConfigDirectoryOptions = {}): string {
  const fileSystem = options.fileSystem ?? REAL_FILE_SYSTEM
  const environment = options.environment ?? process.env
  const startDirectory = options.startDirectory ?? process.cwd()

  const overrideDirectory = environment[CONFIG_DIR_ENV_VAR]?.trim()
  if (overrideDirectory !== undefined && overrideDirectory.length > 0) {
    return overrideDirectory
  }

  let directory = startDirectory
  while (true) {
    if (fileSystem.fileExists(resolve(directory, DEFAULTS_FILENAME))) {
      return directory
    }
    const parent = dirname(directory)
    // At the filesystem root, `dirname` returns its input — that fixed point is the only reliable
    // stop condition, since the root differs by platform.
    if (parent === directory) {
      throw new Error(
        `Could not find ${DEFAULTS_FILENAME} in any parent of ${startDirectory}. ` +
          `Set ${CONFIG_DIR_ENV_VAR} to the directory that holds it.`,
      )
    }
    directory = parent
  }
}

/** Options for {@link loadConfig}. All are test seams; production uses the defaults. */
export interface LoadConfigOptions {
  /** Directory holding the TOML layers (default: {@link findConfigDirectory}). */
  readonly configDirectory?: string
  /** Filesystem access (default: real `node:fs`). */
  readonly fileSystem?: ConfigFileSystem
  /** Environment variables, used only to locate the config directory (default: `process.env`). */
  readonly environment?: EnvironmentVariables
}

/**
 * Load, merge, and validate the configuration. The local layer is optional — its absence is the
 * normal case on a fresh clone, not an error.
 *
 * @throws Error listing every validation problem, labelled with which file(s) it came from.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const fileSystem = options.fileSystem ?? REAL_FILE_SYSTEM
  const configDirectory =
    options.configDirectory ?? findConfigDirectory({ fileSystem, environment: options.environment })

  const defaults = parseToml(fileSystem.readFile(resolve(configDirectory, DEFAULTS_FILENAME)))

  const localPath = resolve(configDirectory, LOCAL_FILENAME)
  const hasLocalLayer = fileSystem.fileExists(localPath)
  const merged = hasLocalLayer ? deepMerge(defaults, parseToml(fileSystem.readFile(localPath))) : defaults

  // Name both files when both contributed, so a validation error points at the right one to edit.
  const sourceLabel = hasLocalLayer ? `${DEFAULTS_FILENAME} + ${LOCAL_FILENAME}` : DEFAULTS_FILENAME
  return parseConfig(merged, sourceLabel)
}

/** Cache for {@link getConfig}, populated on first access. */
let cachedConfig: Config | undefined

/**
 * The validated configuration, loaded once on first call and cached thereafter. This is the accessor
 * application code should use.
 */
export function getConfig(): Config {
  if (cachedConfig === undefined) {
    cachedConfig = loadConfig()
  }
  return cachedConfig
}

/**
 * Drop the cached config so the next {@link getConfig} reloads. Exported for tests that need to
 * observe a different config; production code should not call it.
 */
export function resetConfigCache(): void {
  cachedConfig = undefined
}

/** Options for {@link resolveServiceApiKey}. */
export interface ResolveServiceApiKeyOptions {
  /** The registry key of the service, used only to make the error message actionable. */
  readonly serviceName: string
  /** The validated service entry, whose `apiKeyEnv` names the variable to read. */
  readonly service: ServiceDefinition
  /** Environment variables to read from (default: `process.env`). */
  readonly environment?: EnvironmentVariables
}

/**
 * Read the secret a service names via `apiKeyEnv`.
 *
 * This is the payoff of the env-var-name indirection: the credential is fetched here, at the point
 * of use, and never stored on the config object — so a config dump, a log line, or a serialized
 * error cannot leak it.
 *
 * @throws Error if the service kind has no credential, or the named variable is unset or blank.
 */
export function resolveServiceApiKey(options: ResolveServiceApiKeyOptions): string {
  const { serviceName, service } = options
  const environment = options.environment ?? process.env

  if (service.kind !== 'http') {
    throw new Error(`Service "${serviceName}" is kind "${service.kind}" and has no API key.`)
  }
  // Blank counts as missing: an env var set to the empty string (a common result of `KEY=` in a
  // .env file) would otherwise pass as present and fail later as an auth error.
  const value = environment[service.apiKeyEnv]?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Missing env var ${service.apiKeyEnv} (named by service "${serviceName}" via apiKeyEnv). ` +
        `Set it in .env — never in a committed config file.`,
    )
  }
  return value
}
