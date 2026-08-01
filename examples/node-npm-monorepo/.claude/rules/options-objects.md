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

> **Blueprint note.** The examples below are deliberately generic (orders, stores). When you adopt this
> blueprint, replace them with real call sites from your codebase — an example naming a function that
> does not exist is worse than no example, because agents follow it. See `broken-windows.md`
> § "Don't Broaden Scope While Cleaning".

Functions with more than 2 parameters MUST use a single options object instead of positional
arguments.

**Gated vs. review-only:** Biome's `useMaxParams` (error) is the mechanical floor, and it is a *loose*
one. Left at its default `max: 4`, it reports only when the count **exceeds** four — so it fails CI at
**5+** positional params, not at 4. This rule is **stricter and review-enforced**: convert at **3+**.

So both a 3-parameter and a 4-parameter function pass CI while still violating this rule. Don't wait
for the gate to catch it, and don't read green CI as evidence the convention is met — on this rule the
gate is two params behind it by design. (Threshold verified against the Biome version pinned in
`package.json`; if that pin moves, re-check the default before trusting this paragraph.)

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
  positional (e.g. `formatCurrency(amountCents, currency)`).
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
