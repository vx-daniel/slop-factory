/**
 * Configuration schema — the strict Zod contract for the config tree, with NO I/O.
 *
 * Kept separate from `config.ts` (which reads files) so the whole contract can be unit-tested
 * against crafted objects: no temp files, no fixtures, no filesystem. That split is the reason the
 * tests next door are plain function calls.
 *
 * Tightness comes from four things, each of which turns a class of silent misconfiguration into a
 * boot-time error naming the exact path:
 *   - `z.strictObject` everywhere: an unknown or misspelled key is a hard error, not a no-op.
 *   - a discriminated union on `kind`: each service kind permits exactly its own fields.
 *   - `superRefine` referential integrity: every service a feature names must actually exist.
 *   - enums for closed sets, so `environment = "prod"` fails instead of quietly not matching
 *     `"production"` at some later comparison.
 *
 * REPLACE THE DOMAIN SHAPES BELOW. `app`/`server`/`limits`/`services`/`features` are a
 * demonstration of the available patterns, not a starter set to keep. What is worth preserving is
 * the mechanism: strict objects, inferred types, secrets by env-var NAME, and one `parseConfig`
 * that reports every problem at once.
 */
import { z } from 'zod'

/** Deployment environments. A closed set, so a typo fails at boot rather than at a comparison. */
export const ENVIRONMENTS = ['development', 'staging', 'production'] as const
/** A deployment environment: `development` / `staging` / `production`. */
export type Environment = (typeof ENVIRONMENTS)[number]

/** Log levels, most- to least-verbose. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
/** A log level: `debug` / `info` / `warn` / `error`. */
export type LogLevel = (typeof LOG_LEVELS)[number]

/** The service kind backed by a remote HTTP endpoint, and therefore by a credential. */
export const HTTP_SERVICE_KIND = 'http'
/** The service kind with no endpoint and no credential — a local stand-in, useful in tests. */
export const IN_MEMORY_SERVICE_KIND = 'in-memory'

/** Reusable: a whole number greater than zero (ports, timeouts, concurrency caps). */
const positiveInteger = z.number().int().positive()

/**
 * An HTTP-backed service. `apiKeyEnv` names an environment variable — it is never the key itself.
 * That indirection is what keeps committed config free of credentials, so the validation message
 * says so explicitly: a reader who pastes a real key here should see why it is rejected.
 */
const httpServiceSchema = z.strictObject({
  kind: z.literal(HTTP_SERVICE_KIND),
  baseUrl: z.url({ error: 'baseUrl must be a URL (e.g. http://localhost:8080)' }),
  apiKeyEnv: z.string().min(1, {
    error: 'apiKeyEnv must name an env var (e.g. PRIMARY_API_KEY), not the key itself',
  }),
})

/** An in-memory service. Deliberately field-free: it has no endpoint and no credential. */
const inMemoryServiceSchema = z.strictObject({
  kind: z.literal(IN_MEMORY_SERVICE_KIND),
})

/**
 * One `[services.<name>]` entry, discriminated on `kind`. The discriminated form (rather than a
 * plain union) is what makes an error point at the offending field instead of listing every
 * branch's complaints at once.
 */
const serviceSchema = z.discriminatedUnion('kind', [httpServiceSchema, inMemoryServiceSchema])
/** A validated `[services.<name>]` entry. */
export type ServiceDefinition = z.infer<typeof serviceSchema>

/** An ordered chain of service names: primary first, then fallbacks. At least one entry. */
const serviceChainSchema = z.array(z.string().min(1)).min(1, { error: 'a feature needs at least one service name' })

/**
 * The whole configuration tree. Its inferred type is {@link Config} — never hand-write a parallel
 * interface, or the two drift and TypeScript will not notice.
 */
export const configSchema = z
  .strictObject({
    app: z.strictObject({
      name: z.string().min(1),
      environment: z.enum(ENVIRONMENTS),
    }),
    server: z.strictObject({
      host: z.string().min(1),
      // Upper bound is the real limit on a TCP port; without it, `port = 99999` would pass
      // validation and fail later inside the network stack with a far less obvious message.
      port: z.number().int().min(1).max(65_535),
      requestTimeoutMs: positiveInteger,
    }),
    limits: z.strictObject({
      maxConcurrentJobs: positiveInteger,
      // Nonnegative, not positive: zero retries ("try once, never again") is a legitimate setting.
      maxRetryAttempts: z.number().int().nonnegative(),
    }),
    // OPTIONAL SECTION with per-field defaults. `.prefault({})` — not `.default({})` — is load
    // bearing: prefault feeds `{}` THROUGH this schema so each field's own default applies,
    // whereas `.default({})` hands back the literal `{}` with every field undefined (measured on
    // Zod 4.4.3). It still typechecks either way, so the type system will not catch the swap —
    // the test `applies per-field defaults when the whole section is omitted` is what does,
    // failing with `expected {} to deeply equal { level: 'info' }`. Verified by mutation.
    logging: z
      .strictObject({
        level: z.enum(LOG_LEVELS).default('info'),
      })
      .prefault({}),
    services: z.record(z.string().min(1), serviceSchema).refine((services) => Object.keys(services).length > 0, {
      error: 'define at least one [services.<name>]',
    }),
    features: z.strictObject({
      jobQueue: serviceChainSchema,
    }),
  })
  .superRefine((config, context) => {
    // Referential integrity: a feature may only name a service that exists. Without this a typo
    // stays invisible until the code path runs and dereferences undefined.
    for (const [featureName, serviceNames] of Object.entries(config.features)) {
      for (const serviceName of serviceNames) {
        if (config.services[serviceName] === undefined) {
          const knownServices = Object.keys(config.services).join(', ')
          context.addIssue({
            code: 'custom',
            path: ['features', featureName],
            message: `references unknown service "${serviceName}". Defined services: ${knownServices}.`,
          })
        }
      }
    }
  })

/** The fully validated configuration tree — inferred from {@link configSchema}. */
export type Config = z.infer<typeof configSchema>

/**
 * Validate an already-merged config object.
 *
 * Reports EVERY problem at once, each with its dotted path, rather than failing on the first —
 * so one boot tells you everything to fix instead of one thing per restart. `sourceLabel` names
 * which file(s) produced the object, because "invalid config" is useless when two files merged
 * into it.
 *
 * @throws Error listing every validation problem, prefixed with the source label.
 */
export function parseConfig(raw: unknown, sourceLabel: string): Config {
  const result = configSchema.safeParse(raw)
  if (result.success) {
    return result.data
  }
  const problems = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new Error(`Invalid configuration (${sourceLabel}):\n${problems}`)
}
