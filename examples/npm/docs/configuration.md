# Configuration

Three layers, each with exactly one job. The split exists so the first two can be committed and shared
without ever carrying a credential.

| Layer | File | Committed? | Holds |
|---|---|---|---|
| 1 | `config.defaults.toml` | ✅ **yes** | Safe defaults. Every key the schema requires. |
| 2 | `config.local.toml` | ❌ gitignored | Machine-specific overrides — endpoints, ports, ids. Still no secrets. |
| 3 | `.env` | ❌ gitignored | **Secrets only**, referenced from layers 1–2 *by variable name*. |

Layers 1 and 2 are deep-merged (local wins, **key by key**) and validated together. Layer 3 never
enters the config object at all.

## Getting started

```bash
cp .env.example .env                              # then fill in the values
cp config.local.toml.example config.local.toml    # optional; only if you need overrides
```

## The merge is key-by-key, and that changes how you write the local file

`config.local.toml` should contain **only the keys you change**. Because the merge is key-by-key, a
`[server]` block setting just `port` leaves `host` and `requestTimeoutMs` at their defaults:

```toml
# config.local.toml — correct
[server]
port = 4000
```

**Copying the whole defaults file and editing two lines is the common mistake.** It freezes every other
value at whatever the defaults said the day you copied it, so a later change to a default silently
never reaches you.

**Arrays replace rather than concatenate.** A local `jobQueue = ["staging"]` is the complete new chain,
not an addition. That is deliberate: concatenation would make it impossible to *shorten* a list
locally, which is a thing you need more often than extending one.

## Why secrets are referenced by name

Committed config names the *variable*; the value is read from the environment at the point of use:

```toml
[services.primary]
kind      = "http"
baseUrl   = "http://localhost:8080"
apiKeyEnv = "PRIMARY_API_KEY"     # the NAME — never the key
```

```ts
import { getConfig, resolveServiceApiKey } from '@/config/config.js'

const config = getConfig()
// Throws a message naming both the variable and the service if PRIMARY_API_KEY is unset or blank.
const apiKey = resolveServiceApiKey({ serviceName: 'primary', service: config.services.primary })
```

**The credential never lands on the config object.** That is the property that makes the whole scheme
work: a config dump, a log line, or a serialized error cannot leak a secret, because the secret was
never on the object being dumped.

A missing credential fails at the point of use with a message naming the variable — not later as an
opaque 401.

Add every new variable to `.env.example` too. It is the only discoverable list of what a fresh clone
needs; a variable that exists only in someone's local `.env` is a setup step nobody else can find.

## Two files, because I/O and validation are separable

| File | Role |
|---|---|
| `src/config/config-schema.ts` | The strict Zod contract. **No I/O**, so it unit-tests against plain objects — no fixtures, no temp files. |
| `src/config/config.ts` | Find the directory → merge the layers → validate. Filesystem and environment are injected, defaulting to the real ones. |

That split is why the config tests need no fixtures: the part with all the rules has no dependencies,
and the part with dependencies has almost no rules.

## `getConfig()` is a lazy cached function, not an exported const

```ts
// What this project does
export function getConfig(): AppConfig { /* cached */ }

// What it deliberately avoids
export const config = loadConfig()
```

A module-level `export const config = loadConfig()` makes merely **importing** the module touch the
filesystem — which forces real TOML on disk into every test that transitively imports it, including
tests that have nothing to do with configuration.

## The schema is strict everywhere

An unknown or misspelled key is a **hard error naming its path**, not a silently ignored line. Two
further properties worth knowing:

- **`parseConfig` reports every problem at once**, so one boot tells you everything to fix rather than
  making you play whack-a-mole.
- **Referential integrity is checked.** A feature naming a service that does not exist fails at load
  with a message listing the services that do.

## Adapting it to your project

The shipped `app` / `server` / `limits` / `services` / `features` blocks are a **demonstration of the
available patterns, not a starter set to keep.**

Delete what you do not need and edit `config-schema.ts` to match. The TOML and the schema must agree,
and strictness guarantees you find out immediately if they do not — so edit them together, and let the
error messages guide you.

Delete `src/config/*.test.ts` as you replace the example schema, and write tests for your real one.
Note the 85% coverage floor is live.

What is worth preserving is the **mechanism**: three layers, strict validation, types inferred from the
schema rather than hand-written beside it, and secrets by env-var name.

## Runtime dependencies, not dev

`zod` and `smol-toml` are `dependencies`, **not** `devDependencies`, because config loading happens at
**runtime** — they ship to whatever you deploy to. Everything else in this project (Biome, TypeScript,
Vitest, and the runtime loader if any) is build- or test-time only.

Nothing calls `resolveServiceApiKey` on a fresh clone, so a clone with no `.env` passes the gate. The
snippet above is illustrative: run it before setting `PRIMARY_API_KEY` and it throws, by design.
