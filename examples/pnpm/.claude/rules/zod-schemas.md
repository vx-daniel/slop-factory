---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
trigger_phrase:
  haiku: "zod schema first source of truth"
  opus: "zod schema first boundary validation"
  sonnet: "zod schema first source of truth"
---

# Zod Schemas

## Rule: Schema-First for Boundary Data

Anything that crosses a trust boundary — an HTTP request body, a queue message, a row read back from
a database, an environment variable, a third-party API response — must be validated by a Zod schema,
and its TypeScript type **inferred** from that schema. Do not hand-write a separate interface for
validated data. A corrupt or drifted value must fail loudly *at the boundary*, not silently
propagate.

**Exemptions**: factory option objects (`*Options`, see `options-objects.md`) and internal domain
types may be plain interfaces/unions — they describe behaviour contracts and in-process values, not
validated input off the wire.

```typescript
// WRONG — a separate interface for a validated wire payload. The two drift, and nothing catches it:
// the schema stops matching the type, and TypeScript is satisfied because it only sees the interface.
interface CreateOrderRequest {
  customerId: string
  items: OrderItem[]
  paymentMethod: PaymentMethod
}

// CORRECT — one declaration; the type is derived, so drift is impossible
export const createOrderRequestSchema = z.object({
  customerId: z.string().min(1),
  items: z.array(orderItemSchema).min(1),
  paymentMethod: z.enum(PAYMENT_METHODS),
})
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>
```

## Schema Location

Schemas are **colocated with the boundary they guard**, not collected into a central `schemas.ts`.
The request schema lives with the route that accepts it; a read-boundary schema lives in the module
that owns the read. A shared `schemas.ts` becomes a dumping ground that every module imports,
and the coupling hides which boundary a given schema actually protects.

Name schemas `<thing>Schema` in camelCase; the inferred type takes the PascalCase name.

## Discriminated Unions

For **validated boundary data** with a shape-per-branch, use `z.discriminatedUnion('<tag>', [...])`
rather than a hand-written union — it produces a targeted error naming the branch, where a plain
union reports every branch's failure at once.

```typescript
const webhookEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('order.created'), orderId: z.string() }),
  z.object({ type: z.literal('order.refunded'), orderId: z.string(), amountCents: z.number().int() }),
])
```

For **internal** domain types that never hit a schema, a hand-written discriminated union is correct
— see `typescript-patterns.md`.

## Schema Composition

```typescript
const detailedConfigSchema = clientConfigSchema.extend({ timeoutMs: z.number().int().positive() })
const publicConfigSchema = clientConfigSchema.omit({ apiToken: true })
const serverOnlySchema = clientConfigSchema.pick({ server: true })
```

## Strict Objects at Config Boundaries

For data you own both ends of — a config file, an internal message — prefer `z.strictObject(...)`.
An unknown or misspelled key becomes a hard error rather than a silent no-op, which is the difference
between "my setting isn't working" and a message naming the typo.

Use plain `z.object(...)` for third-party payloads: a provider adding a field must not break you.

## Zod 4 Syntax

This blueprint pins Zod 4. Use the v4 error API — the v3 form is silently ignored, so a wrong
`message` key produces the default error text and the custom message never appears:

```typescript
// CORRECT — Zod 4
z.string().min(1, { error: 'customerId is required' })

// WRONG — Zod 3; the option is ignored, not rejected
z.string().min(1, { message: 'customerId is required' })
```

`z.looseObject(...)` is the Zod 4 form of Zod 3's `.passthrough()` — use it for a schema that must
accept unknown keys. `.passthrough()` does not exist in Zod 4.

## Shared Field Extraction

When the same field/sub-schema appears in 2+ schemas, extract it — but apply the rule-of-three from
`broken-windows.md`: extract at the **third** occurrence, not the first. A field extracted too early
usually has to be un-extracted when the second use case turns out to need different validation.

```typescript
// Worth extracting once several schemas need identical, non-trivial validation:
const customerIdField = z.string().uuid()
```
