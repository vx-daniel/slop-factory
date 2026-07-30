import { describe, expect, it } from 'vitest'
import { type Config, parseConfig } from './config-schema.js'

/**
 * A minimal valid config object. Tests start from this and mutate one thing, so each assertion
 * isolates a single rule rather than depending on a large shared fixture.
 */
function buildValidRawConfig(): Record<string, unknown> {
  return {
    app: { name: 'test-app', environment: 'development' },
    server: { host: '127.0.0.1', port: 3000, requestTimeoutMs: 30_000 },
    limits: { maxConcurrentJobs: 4, maxRetryAttempts: 2 },
    logging: { level: 'info' },
    services: {
      primary: { kind: 'http', baseUrl: 'http://localhost:8080', apiKeyEnv: 'PRIMARY_API_KEY' },
      scratch: { kind: 'in-memory' },
    },
    features: { jobQueue: ['primary', 'scratch'] },
  }
}

const SOURCE_LABEL = 'test-config.toml'

describe('parseConfig — accepting a valid tree', () => {
  it('returns the fully typed config, preserving every value', () => {
    const config: Config = parseConfig(buildValidRawConfig(), SOURCE_LABEL)

    expect(config).toEqual({
      app: { name: 'test-app', environment: 'development' },
      server: { host: '127.0.0.1', port: 3000, requestTimeoutMs: 30_000 },
      limits: { maxConcurrentJobs: 4, maxRetryAttempts: 2 },
      logging: { level: 'info' },
      services: {
        primary: { kind: 'http', baseUrl: 'http://localhost:8080', apiKeyEnv: 'PRIMARY_API_KEY' },
        scratch: { kind: 'in-memory' },
      },
      features: { jobQueue: ['primary', 'scratch'] },
    })
  })

  it('accepts zero retry attempts, which means "try once and give up"', () => {
    const raw = buildValidRawConfig()
    raw.limits = { maxConcurrentJobs: 1, maxRetryAttempts: 0 }

    expect(parseConfig(raw, SOURCE_LABEL).limits.maxRetryAttempts).toBe(0)
  })
})

describe('parseConfig — the optional [logging] section', () => {
  // Guards the `.prefault({})` vs `.default({})` distinction called out in the schema. With
  // `.default({})` this test fails: `level` comes back undefined rather than 'info'.
  it('applies per-field defaults when the whole section is omitted', () => {
    const raw = buildValidRawConfig()
    delete raw.logging

    expect(parseConfig(raw, SOURCE_LABEL).logging).toEqual({ level: 'info' })
  })

  it('rejects a level outside the closed set', () => {
    const raw = buildValidRawConfig()
    raw.logging = { level: 'verbose' }

    expect(() => parseConfig(raw, SOURCE_LABEL)).toThrow(/logging\.level/)
  })
})

describe('parseConfig — strictness', () => {
  it('rejects an unknown top-level key rather than ignoring it', () => {
    const raw = buildValidRawConfig()
    raw.unexpectedSection = { anything: true }

    expect(() => parseConfig(raw, SOURCE_LABEL)).toThrow(/unexpectedSection/)
  })

  it('rejects a misspelled key inside a section, naming its path', () => {
    const raw = buildValidRawConfig()
    raw.server = { host: '127.0.0.1', port: 3000, requestTimeoutMS: 30_000 }

    expect(() => parseConfig(raw, SOURCE_LABEL)).toThrow(/server/)
  })

  it('rejects a field belonging to a different service kind', () => {
    const raw = buildValidRawConfig()
    // `baseUrl` is valid on an `http` service but must not be accepted on an `in-memory` one.
    raw.services = { scratch: { kind: 'in-memory', baseUrl: 'http://localhost:8080' } }
    raw.features = { jobQueue: ['scratch'] }

    expect(() => parseConfig(raw, SOURCE_LABEL)).toThrow(/baseUrl/)
  })

  it('rejects an unknown service kind', () => {
    const raw = buildValidRawConfig()
    raw.services = { mystery: { kind: 'carrier-pigeon' } }
    raw.features = { jobQueue: ['mystery'] }

    expect(() => parseConfig(raw, SOURCE_LABEL)).toThrow(/services/)
  })
})

describe('parseConfig — value constraints', () => {
  it('rejects a port above the TCP maximum', () => {
    const raw = buildValidRawConfig()
    raw.server = { host: '127.0.0.1', port: 99_999, requestTimeoutMs: 30_000 }

    expect(() => parseConfig(raw, SOURCE_LABEL)).toThrow(/server\.port/)
  })

  it('rejects a non-URL baseUrl', () => {
    const raw = buildValidRawConfig()
    raw.services = { primary: { kind: 'http', baseUrl: 'not-a-url', apiKeyEnv: 'PRIMARY_API_KEY' } }
    raw.features = { jobQueue: ['primary'] }

    expect(() => parseConfig(raw, SOURCE_LABEL)).toThrow(/baseUrl must be a URL/)
  })

  it('rejects an empty apiKeyEnv with a message explaining it names a variable', () => {
    const raw = buildValidRawConfig()
    raw.services = { primary: { kind: 'http', baseUrl: 'http://localhost:8080', apiKeyEnv: '' } }
    raw.features = { jobQueue: ['primary'] }

    expect(() => parseConfig(raw, SOURCE_LABEL)).toThrow(/must name an env var/)
  })

  it('rejects an empty services registry', () => {
    const raw = buildValidRawConfig()
    raw.services = {}
    raw.features = { jobQueue: ['primary'] }

    expect(() => parseConfig(raw, SOURCE_LABEL)).toThrow(/at least one/)
  })

  it('rejects an empty feature chain', () => {
    const raw = buildValidRawConfig()
    raw.features = { jobQueue: [] }

    expect(() => parseConfig(raw, SOURCE_LABEL)).toThrow(/at least one service name/)
  })
})

describe('parseConfig — referential integrity', () => {
  it('rejects a feature naming a service that does not exist, and lists the ones that do', () => {
    const raw = buildValidRawConfig()
    raw.features = { jobQueue: ['primary', 'typoed-name'] }

    expect(() => parseConfig(raw, SOURCE_LABEL)).toThrow(/references unknown service "typoed-name".*primary, scratch/s)
  })
})

describe('parseConfig — error reporting', () => {
  it('names the source in the message so a merged config points at the right file', () => {
    expect(() => parseConfig({}, 'config.defaults.toml + config.local.toml')).toThrow(
      /Invalid configuration \(config\.defaults\.toml \+ config\.local\.toml\)/,
    )
  })

  it('reports every problem at once rather than only the first', () => {
    const raw = buildValidRawConfig()
    raw.app = { name: '', environment: 'nonexistent-environment' }
    raw.server = { host: '127.0.0.1', port: -1, requestTimeoutMs: 30_000 }

    let message = ''
    try {
      parseConfig(raw, SOURCE_LABEL)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toMatch(/app\.name/)
    expect(message).toMatch(/app\.environment/)
    expect(message).toMatch(/server\.port/)
  })
})
