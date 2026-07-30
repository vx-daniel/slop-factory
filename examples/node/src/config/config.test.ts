import { beforeEach, describe, expect, it } from 'vitest'
import {
  type ConfigFileSystem,
  deepMerge,
  findConfigDirectory,
  getConfig,
  loadConfig,
  resetConfigCache,
  resolveServiceApiKey,
} from './config.js'

const DEFAULTS_FILENAME = 'config.defaults.toml'
const LOCAL_FILENAME = 'config.local.toml'
const CONFIG_DIRECTORY = '/repo'

/** A complete, valid defaults layer — the committed-file equivalent, as TOML text. */
const VALID_DEFAULTS_TOML = `
[app]
name = "my-application"
environment = "development"

[server]
host = "127.0.0.1"
port = 3000
requestTimeoutMs = 30000

[limits]
maxConcurrentJobs = 4
maxRetryAttempts = 2

[logging]
level = "info"

[services.primary]
kind = "http"
baseUrl = "http://localhost:8080"
apiKeyEnv = "PRIMARY_API_KEY"

[services.scratch]
kind = "in-memory"

[features]
jobQueue = ["primary", "scratch"]
`

/**
 * An in-memory {@link ConfigFileSystem} over a path→contents map. A path absent from the map does
 * not exist, which is how the "no local layer" case is expressed.
 */
function createFakeFileSystem(filesByPath: Record<string, string>): ConfigFileSystem {
  return {
    fileExists: (path: string): boolean => Object.hasOwn(filesByPath, path),
    readFile: (path: string): string => {
      const contents = filesByPath[path]
      if (contents === undefined) {
        throw new Error(`fake file system: no such file ${path}`)
      }
      return contents
    },
  }
}

describe('deepMerge', () => {
  it('merges nested plain objects key by key instead of replacing the branch', () => {
    const merged = deepMerge(
      { server: { host: '127.0.0.1', port: 3000 }, app: { name: 'base' } },
      { server: { port: 9999 } },
    )

    // host survives even though the override only mentioned port — this is what lets
    // config.local.toml carry only the keys it changes.
    expect(merged).toEqual({ server: { host: '127.0.0.1', port: 9999 }, app: { name: 'base' } })
  })

  it('replaces arrays wholesale rather than concatenating them', () => {
    const merged = deepMerge({ features: { jobQueue: ['a', 'b', 'c'] } }, { features: { jobQueue: ['z'] } })

    // Concatenation would make it impossible to SHORTEN a chain in the local layer.
    expect(merged).toEqual({ features: { jobQueue: ['z'] } })
  })

  it('lets a scalar override replace an object', () => {
    expect(deepMerge({ logging: { level: 'info' } }, { logging: 'replaced' })).toEqual({ logging: 'replaced' })
  })

  it('treats null as a replacing value, not a mergeable object', () => {
    expect(deepMerge({ logging: { level: 'info' } }, { logging: null })).toEqual({ logging: null })
  })

  it('returns the override when the base is not an object', () => {
    expect(deepMerge(42, { level: 'info' })).toEqual({ level: 'info' })
  })

  it('adds keys the base does not have', () => {
    expect(deepMerge({ host: 'localhost' }, { port: 3000 })).toEqual({ host: 'localhost', port: 3000 })
  })
})

describe('findConfigDirectory', () => {
  it('returns the start directory when the defaults file is right there', () => {
    const fileSystem = createFakeFileSystem({ [`${CONFIG_DIRECTORY}/${DEFAULTS_FILENAME}`]: '' })

    expect(findConfigDirectory({ startDirectory: CONFIG_DIRECTORY, fileSystem, environment: {} })).toBe(
      CONFIG_DIRECTORY,
    )
  })

  it('walks up from a subdirectory to find the defaults file', () => {
    const fileSystem = createFakeFileSystem({ [`${CONFIG_DIRECTORY}/${DEFAULTS_FILENAME}`]: '' })

    const found = findConfigDirectory({
      startDirectory: `${CONFIG_DIRECTORY}/src/deeply/nested`,
      fileSystem,
      environment: {},
    })

    expect(found).toBe(CONFIG_DIRECTORY)
  })

  // Load-bearing for the monorepo path (docs/monorepo.md): a package nested at packages/<name>/
  // must find the ROOT config.defaults.toml with no per-package configuration. If this breaks, every
  // workspace package needs its own copy of the config — which is the drift the single committed
  // defaults file exists to prevent.
  it('finds the root defaults file from inside a nested workspace package', () => {
    const fileSystem = createFakeFileSystem({ [`${CONFIG_DIRECTORY}/${DEFAULTS_FILENAME}`]: '' })

    const found = findConfigDirectory({
      startDirectory: `${CONFIG_DIRECTORY}/packages/api/src/routes`,
      fileSystem,
      environment: {},
    })

    expect(found).toBe(CONFIG_DIRECTORY)
  })

  it('prefers APP_CONFIG_DIR over the upward walk', () => {
    // The defaults file exists at the start directory, so a walk would succeed — proving the
    // override short-circuits rather than merely acting as a fallback.
    const fileSystem = createFakeFileSystem({ [`${CONFIG_DIRECTORY}/${DEFAULTS_FILENAME}`]: '' })

    const found = findConfigDirectory({
      startDirectory: CONFIG_DIRECTORY,
      fileSystem,
      environment: { APP_CONFIG_DIR: '/mounted/config' },
    })

    expect(found).toBe('/mounted/config')
  })

  it('ignores a blank APP_CONFIG_DIR and falls back to the walk', () => {
    const fileSystem = createFakeFileSystem({ [`${CONFIG_DIRECTORY}/${DEFAULTS_FILENAME}`]: '' })

    const found = findConfigDirectory({
      startDirectory: CONFIG_DIRECTORY,
      fileSystem,
      environment: { APP_CONFIG_DIR: '   ' },
    })

    expect(found).toBe(CONFIG_DIRECTORY)
  })

  it('throws naming the override variable when no defaults file exists anywhere above', () => {
    const fileSystem = createFakeFileSystem({})

    expect(() => findConfigDirectory({ startDirectory: '/nowhere/at/all', fileSystem, environment: {} })).toThrow(
      /APP_CONFIG_DIR/,
    )
  })
})

describe('loadConfig', () => {
  it('loads and validates the defaults layer alone when no local layer exists', () => {
    const fileSystem = createFakeFileSystem({
      [`${CONFIG_DIRECTORY}/${DEFAULTS_FILENAME}`]: VALID_DEFAULTS_TOML,
    })

    const config = loadConfig({ configDirectory: CONFIG_DIRECTORY, fileSystem })

    expect(config.app.name).toBe('my-application')
    expect(config.server.port).toBe(3000)
    expect(config.features.jobQueue).toEqual(['primary', 'scratch'])
  })

  it('lets the local layer override individual keys while the rest of the section survives', () => {
    const fileSystem = createFakeFileSystem({
      [`${CONFIG_DIRECTORY}/${DEFAULTS_FILENAME}`]: VALID_DEFAULTS_TOML,
      [`${CONFIG_DIRECTORY}/${LOCAL_FILENAME}`]: '[server]\nport = 8443\n',
    })

    const config = loadConfig({ configDirectory: CONFIG_DIRECTORY, fileSystem })

    expect(config.server.port).toBe(8443)
    // Untouched keys in the same section must survive the merge.
    expect(config.server.host).toBe('127.0.0.1')
    expect(config.server.requestTimeoutMs).toBe(30_000)
  })

  it('lets the local layer add a service and point a feature at it', () => {
    const fileSystem = createFakeFileSystem({
      [`${CONFIG_DIRECTORY}/${DEFAULTS_FILENAME}`]: VALID_DEFAULTS_TOML,
      [`${CONFIG_DIRECTORY}/${LOCAL_FILENAME}`]: [
        '[services.staging]',
        'kind = "http"',
        'baseUrl = "https://staging.example.com"',
        'apiKeyEnv = "STAGING_API_KEY"',
        '',
        '[features]',
        'jobQueue = ["staging"]',
      ].join('\n'),
    })

    const config = loadConfig({ configDirectory: CONFIG_DIRECTORY, fileSystem })

    expect(Object.keys(config.services).sort()).toEqual(['primary', 'scratch', 'staging'])
    expect(config.features.jobQueue).toEqual(['staging'])
  })

  it('names only the defaults file in the error when there is no local layer', () => {
    const fileSystem = createFakeFileSystem({
      [`${CONFIG_DIRECTORY}/${DEFAULTS_FILENAME}`]: '[app]\nname = "x"\n',
    })

    expect(() => loadConfig({ configDirectory: CONFIG_DIRECTORY, fileSystem })).toThrow(
      /Invalid configuration \(config\.defaults\.toml\):/,
    )
  })

  it('names both files in the error when the local layer contributed to the invalid result', () => {
    const fileSystem = createFakeFileSystem({
      [`${CONFIG_DIRECTORY}/${DEFAULTS_FILENAME}`]: VALID_DEFAULTS_TOML,
      // Valid on its own, but pushes the merged port past the TCP maximum.
      [`${CONFIG_DIRECTORY}/${LOCAL_FILENAME}`]: '[server]\nport = 99999\n',
    })

    expect(() => loadConfig({ configDirectory: CONFIG_DIRECTORY, fileSystem })).toThrow(
      /Invalid configuration \(config\.defaults\.toml \+ config\.local\.toml\):[\s\S]*server\.port/,
    )
  })

  it('locates the config directory itself when none is supplied', () => {
    const fileSystem = createFakeFileSystem({
      [`${CONFIG_DIRECTORY}/${DEFAULTS_FILENAME}`]: VALID_DEFAULTS_TOML,
    })

    // No configDirectory: the loader must fall through to findConfigDirectory, which the
    // APP_CONFIG_DIR override steers at the fake filesystem.
    const config = loadConfig({ fileSystem, environment: { APP_CONFIG_DIR: CONFIG_DIRECTORY } })

    expect(config.app.name).toBe('my-application')
  })
})

/**
 * The only tests here that touch the real filesystem — deliberately. Everything above runs against
 * crafted content, which proves the LOGIC; these prove the shipped artifacts are wired correctly.
 *
 * The committed `config.defaults.toml` is otherwise unguarded: it is never imported by production
 * code at build time, so a stray edit that breaks it (a misspelled key, a removed required section,
 * a feature naming a service that was deleted) would pass the whole gate and fail at first boot.
 * This is the check that catches it.
 */
describe('getConfig — against the real committed config.defaults.toml', () => {
  beforeEach(() => {
    resetConfigCache()
  })

  it('loads and validates the repository’s own defaults file', () => {
    const config = getConfig()

    // Deliberately loose on VALUES (the defaults file is meant to be edited) and strict on
    // STRUCTURE (which is what the schema contract guarantees).
    expect(config.app.name.length).toBeGreaterThan(0)
    expect(Object.keys(config.services).length).toBeGreaterThan(0)
    expect(config.features.jobQueue.length).toBeGreaterThan(0)
  })

  it('points every feature at a service that actually exists in the shipped defaults', () => {
    const config = getConfig()

    for (const serviceName of config.features.jobQueue) {
      expect(config.services).toHaveProperty(serviceName)
    }
  })

  it('caches, so repeated calls do not re-read the filesystem', () => {
    // Reference equality, not deep equality: a second read would produce an equal-but-distinct
    // object, so `toBe` is what distinguishes a cache hit from a reload.
    expect(getConfig()).toBe(getConfig())
  })

  it('reloads after the cache is reset', () => {
    const first = getConfig()
    resetConfigCache()

    expect(getConfig()).not.toBe(first)
  })
})

describe('resolveServiceApiKey', () => {
  const httpService = {
    kind: 'http',
    baseUrl: 'http://localhost:8080',
    apiKeyEnv: 'PRIMARY_API_KEY',
  } as const

  it('returns the value of the environment variable the service names', () => {
    const key = resolveServiceApiKey({
      serviceName: 'primary',
      service: httpService,
      environment: { PRIMARY_API_KEY: 'real-secret-value' },
    })

    expect(key).toBe('real-secret-value')
  })

  it('trims surrounding whitespace, which .env files pick up easily', () => {
    const key = resolveServiceApiKey({
      serviceName: 'primary',
      service: httpService,
      environment: { PRIMARY_API_KEY: '  padded-secret  ' },
    })

    expect(key).toBe('padded-secret')
  })

  it('throws naming both the variable and the service when it is unset', () => {
    expect(() => resolveServiceApiKey({ serviceName: 'primary', service: httpService, environment: {} })).toThrow(
      /Missing env var PRIMARY_API_KEY.*"primary"/,
    )
  })

  it('treats a blank value as missing rather than as a valid empty key', () => {
    // `PRIMARY_API_KEY=` in a .env file yields the empty string. Accepting it would defer the
    // failure to an opaque 401 from the remote service.
    expect(() =>
      resolveServiceApiKey({
        serviceName: 'primary',
        service: httpService,
        environment: { PRIMARY_API_KEY: '   ' },
      }),
    ).toThrow(/Missing env var PRIMARY_API_KEY/)
  })

  it('throws for a service kind that has no credential at all', () => {
    expect(() =>
      resolveServiceApiKey({
        serviceName: 'scratch',
        service: { kind: 'in-memory' },
        environment: { PRIMARY_API_KEY: 'unused' },
      }),
    ).toThrow(/has no API key/)
  })
})
