---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
  - "scripts/**/*.ts"
trigger_phrase:
  haiku: "typescript safety patterns enforced"
  opus: "strict typescript type safety rules"
  sonnet: "strict typescript safety enforcement rules"
---

# TypeScript Patterns

This repo is `strict: true` (TypeScript 7, ESM with `.js` import extensions under
`moduleResolution: NodeNext`). The patterns below keep it type-safe.

## Enforced Patterns

### No `any` Type

Gated: `noExplicitAny` is an error in `biome.json`. Use `unknown` plus Zod validation. Boundary data
— a request body, a queue message, a row read back from a database — goes through a schema at the
boundary (see `zod-schemas.md`).

```typescript
// WRONG
function handleRecord(body: any) { return body.customerId }

// WRONG — an unsafe cast is the same bug wearing a different hat. `as` asserts; it never checks.
function handleRecord(body: unknown) { return (body as CreateOrderRequest).customerId }

// CORRECT — Zod validation at the boundary
function handleRecord(body: unknown): CreateOrderRequest {
  return createOrderRequestSchema.parse(body)
}
```

### No `@ts-ignore` — Use `@ts-expect-error` with Justification

Gated: `noTsIgnore` is an error in `biome.json`. `@ts-expect-error` is preferred because it *itself*
errors once the underlying problem is fixed, so the suppression cannot outlive its reason —
`@ts-ignore` silently persists forever.

```typescript
// WRONG
// @ts-ignore
const value = someUntypedThirdPartyApi()

// CORRECT — with explanation (only when a dependency genuinely ships no types)
// @ts-expect-error — <package> ships no types for this entry point; tracked upstream at <link>
import { thing } from 'some-untyped-package/deep/entry.js'
```

If you reach for a suppression, that is a signal to re-check the type model first (see
`agent-discipline.md` STUCK), not a routine move.

### Explicit Return Types on Exported Functions

Also enforced as a Biome warning (`useExplicitType`) — which covers parameters as well as return types,
and is not limited to exports. Exempt are the positions that already supply the type: callbacks passed
as call arguments, IIFEs, and functions assigned to an annotated declarator. A callback on an object
property is **not** exempt; see `naming-and-style.md` § "Enforcement" for why that keeps it a warning.

Beyond documentation, an explicit return type makes the *function* the error site when the body drifts
from the contract. Without one, the inferred type silently widens and the error surfaces at some
distant call site instead.

```typescript
// WRONG
export function buildOrderSummary(order, currency) { ... }

// CORRECT
export function buildOrderSummary(order: Order, currency: Currency): OrderSummary { ... }
```

### `as const` for Constants

Preserves literal types and enables type derivation — one declaration drives both the runtime tuple
and the compile-time union, so they cannot disagree.

```typescript
export const ORDER_STATUSES = ['pending', 'shipped', 'delivered', 'cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]
```

### `satisfies` for Type Checking Without Widening

```typescript
// Validates the shape while preserving literal types
const EXIT_CODES = { ok: 0, usage: 1, error: 2 } as const satisfies Record<string, number>
EXIT_CODES.error // type: 2 (not number)
```

### Nullish Coalescing `??` Over Falsy `||`

```typescript
// WRONG — also replaces 0 and '', which are legitimate values
const pageSize = flagNumber(args, 'page-size') || DEFAULT_PAGE_SIZE

// CORRECT — only replaces null/undefined
const pageSize = flagNumber(args, 'page-size') ?? DEFAULT_PAGE_SIZE
```

**Exception**: `||` is correct when the empty string genuinely *should* be replaced (e.g.
`displayName || '<unnamed>'`), and `|| 0` is correct when guarding `NaN`, since `NaN ?? 0` does not
catch `NaN`.

## Patterns to Adopt

### `readonly` for Function Parameters

Prevents accidental mutation of arrays/objects passed in. Callers hand you a reference, not a copy —
sorting it in place mutates *their* array, and that class of bug is invisible at the call site.

```typescript
function serialize(values: readonly bigint[]): SerializedList {
  // values.sort(...) // ERROR: cannot mutate — and `.sort()` would have mutated the caller's array
  const sortedValues = [...values].sort(compareAscending)
  // ...
}
```

### Type Predicates for Runtime Narrowing

Narrow with a real runtime check — `instanceof`, a discriminant, or a `value is T` predicate — so
only the case you meant to handle is swallowed and everything else propagates.

```typescript
try {
  await client.update(record)
} catch (error) {
  if (error instanceof NotFoundError) {
    await client.create(record)
    return
  }
  throw error // anything else is not ours to swallow
}
```

### Discriminated Unions

For **validated boundary data**, prefer `z.discriminatedUnion()` (see `zod-schemas.md`). For
**internal domain types** that never cross a validation boundary, a hand-written discriminated union
is correct — TypeScript narrows each branch on the discriminant.

```typescript
type Command =
  | { readonly kind: 'fetch'; readonly resourceId: string }
  | { readonly kind: 'range'; readonly start: number; readonly count: number }
```

### Exhaustive Switch with `never`

Use when a switch must handle every variant and a missed case should fail at build time. Add a
variant to the union and every non-exhaustive switch becomes a compile error — the compiler finds
the call sites for you.

```typescript
function describe(status: OrderStatus): string {
  switch (status) {
    case 'pending': return 'awaiting payment'
    case 'shipped': return 'in transit'
    case 'delivered': return 'delivered'
    case 'cancelled': return 'cancelled'
    default: {
      const exhaustiveCheck: never = status
      throw new Error(`Unhandled order status: ${exhaustiveCheck}`)
    }
  }
}
```

Biome's `useExhaustiveSwitchCases` (error) also catches this; the `never` binding additionally
documents the intent at the site.

## Type Suppression in Tests

`as any` and `@ts-expect-error` are acceptable in test files **only** to construct a deliberately
invalid state, with a comment saying why. Never to make a legitimate test compile — that is a signal
the test is exercising something the types forbid, which is a finding to investigate rather than
silence (see `agent-discipline.md`).

```typescript
// Intentionally feeding a malformed body to prove the Zod boundary rejects it
// @ts-expect-error — passing a non-object to test the schema guard
expect(() => createOrderRequestSchema.parse(42)).toThrow()
```
