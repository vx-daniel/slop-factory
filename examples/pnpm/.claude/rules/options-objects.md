---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
  - "scripts/**/*.ts"
trigger_phrase:
  haiku: "options objects over positional parameters"
  opus: "options object over positional params"
  sonnet: "options object over positional params"
---

# Options Objects Over Positional Parameters

Functions with more than 2 parameters MUST use a single options object instead of positional
arguments.

**Gated vs. review-only:** Biome's `useMaxParams` (error, at its default threshold of **4**) is the
mechanical floor — it fails CI at 4+ positional params. This rule is **stricter and review-enforced**:
convert at **3+**. So a 3-parameter function passes CI but still violates this rule — don't wait for
the gate to catch it, and don't assume green CI means the convention is met.

## Rule

```typescript
// WRONG — positional parameters
function createPostgresOrderStore(client: DatabaseClient, schemaName: string, now: () => number) { ... }

// WRONG — positional + trailing opts bag (the two-tier pattern)
function createPostgresOrderStore(client: DatabaseClient, opts: { schemaName: string; now?: () => number }) { ... }

// CORRECT — single options object
function createPostgresOrderStore(options: PostgresOrderStoreOptions): OrderStore { ... }
```

## When This Applies

- **3+ parameters**: Convert to an options object. Functions with 1–2 parameters are fine as
  positional (e.g. `flagString(args, key)`).
- **Exported functions**: Always use options objects when 3+ params — callers benefit the most.
- **Internal/private functions**: Same rule. Consistency reduces cognitive overhead and makes future
  extraction easier.
- **Callbacks and event handlers**: Short callbacks like `(completed, total) => void` are exempt —
  the positional form is clearer for 1–2 arg signatures.

## Why

- **Readability at call sites**: `createPostgresOrderStore({ client, schemaName, now })` is
  self-documenting; `createPostgresOrderStore(client, schemaName, now)` requires memorizing order.
- **Non-breaking extensibility**: Adding an optional field to an options object is backwards
  compatible. Adding a positional parameter shifts every existing call site.
- **Eliminates trailing opts bags**: The two-tier pattern (`required positional + optional bag`)
  forces callers to reason about which tier a parameter belongs to. A flat object removes the
  distinction.

## Interface Naming

Name the options interface after the function/factory, suffixed `Options` —
`PostgresOrderStoreOptions`, not `…Opts`. (`opts` is one of the few abbreviations the naming gate
deliberately permits as a *parameter* name, but the interface itself always spells `Options` in full.)

```typescript
export interface PostgresOrderStoreOptions {
  readonly client: DatabaseClient
  readonly schemaName: string
  /** Injectable clock — tests pass a fixed value so assertions are not time-dependent. */
  readonly now?: () => number
}

export function createPostgresOrderStore(options: PostgresOrderStoreOptions): OrderStore { ... }
```

For internal (non-exported) functions, inline the object type in the signature rather than creating a
named interface.

## Destructuring

Destructure at the top of the function body, not in the parameter list:

```typescript
// CORRECT
export function createPostgresOrderStore(options: PostgresOrderStoreOptions): OrderStore {
  const { client, schemaName } = options
  const now = options.now ?? Date.now
  // ...
}

// WRONG — destructuring in the parameter hides the type name at the reader's first encounter
export function createPostgresOrderStore({ client, schemaName, now }: PostgresOrderStoreOptions): OrderStore {
  // ...
}
```
