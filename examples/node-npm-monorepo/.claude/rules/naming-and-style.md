---
trigger_phrase:
  haiku: "typescript naming style conventions"
  opus: "typescript verbose naming readability conventions"
  sonnet: "verbose naming style rules"
always_on: true
---

# Naming and Style

> **Blueprint note.** The examples below are deliberately generic (orders, sessions). When you adopt
> this blueprint, replace them with real call sites from your codebase — an example pointing at a
> module that does not exist is worse than no example, because agents follow it. See
> `broken-windows.md` § "Don't Broaden Scope While Cleaning".

## Enforcement

**Gated by Biome** (`biome.json`, `recommended` preset plus these repo overrides):

- `noNestedTernary` (error), `useNumericSeparators` (error — group digits: `900_000`, `0xaf_fb_e5_b6`),
  `useThrowNewError` / `useThrowOnlyError` (error), `noNonNullAssertion` (error — no `x!`),
  `useExplicitLengthCheck` (error — `array.length > 0`, not `array.length`).
- `noProcessEnv`: **off in source** (`**/*.ts` except `*.test.ts` — composition roots legitimately
  read env vars) but **error in tests** (a test that reads `process.env` should inject instead; see
  the `process.env` section below).
- `useExplicitType` (warn) — explicit types on functions, methods, variables **and parameters**, not
  only exported ones. It exempts functions whose type the position already supplies: callbacks passed
  as **call arguments**, IIFEs, and functions assigned to an annotated declarator. It does **not**
  exempt every callback — one assigned to an object property whose type a library leaves implicit is
  still reported. That case is why the rule is a warning rather than an error: it is nursery-tier and
  handles library-supplied callback types worst, and annotating them means asserting a shape the
  library does not promise.

**Gated by the naming plugin** (`.biome/naming.grit`, a GritQL plugin registered via biome.json's
`plugins` key — it runs as part of the `lint` script):

- **Abbreviations** in bindings and property keys — `cfg`, `ctx`, `msg`, `req`, `res`, `idx`, `tmp`,
  and ~70 more — are **errors**.
- **Single-character** bindings are **warnings**; single-character property keys are **errors**.
  Exempt: `_` and `z` for bindings, plus `e` for keys. `i`/`j`/`k` are **not** exempt.
- **Generic iteration names** (`item`, `value`, `data`, `index`, `result`, …) in `.map`/`.filter`/
  `for` headers surface as `info` — advisory, does not fail CI.

The plugin's allowlist ships **empty**. Before adding to it, read the note above `is_allowlisted` —
an inherited allowlist silently permits abbreviations that mean nothing in your project.

**Review-only** (no mechanical gate): action+subject function names, boolean `is/has/should/can`
prefixes, one-operation-per-line. Run the `lint` script (or `check:all`) to see the gated ones —
through whichever package manager this project uses, which `CLAUDE.md` names.

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Files (.ts) | kebab-case | `order-store.ts`, `serialize.ts`, `session-state.ts` |
| Classes | PascalCase | `OrderStore`, `NotImplementedError` |
| Functions | camelCase | `createPostgresOrderStore`, `buildOrderSummary` |
| Constants | SCREAMING_SNAKE | `MAX_RETRY_ATTEMPTS`, `DEFAULT_PAGE_SIZE` |
| Interfaces | PascalCase (no I prefix) | `OrderStore`, `OrderStoreOptions` |
| Types | PascalCase | `OrderStatus`, `PaymentMethod` |
| Zod schemas | camelCase + `Schema` | `createOrderRequestSchema`, `storedOrderSchema` |

> Zod schemas are **camelCase** (`createOrderRequestSchema`); the inferred type takes the PascalCase
> name (`type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>`).

## Verbose Names — No Abbreviations

Always use full, descriptive names. Never abbreviate. **This tier is gated** — the names on the left
are lint errors, not style preferences.

```typescript
// WRONG — abbreviations and shorthand
const cfg = buildDependencies()
const ctx = createDatabaseClient()
const buf = packLittleEndian(values, width)
const res = await store.getOrder(orderId)
const msg = 'order creation failed'
const cb = (error) => {}
const idx = orderIds.indexOf(target)

// CORRECT — full descriptive names
const configuration = buildDependencies()
const databaseClient = createDatabaseClient()
const packedBytes = packLittleEndian(values, width)
const order = await store.getOrder(orderId)
const message = 'order creation failed'
const handleError = (error) => {}
const index = orderIds.indexOf(target)
```

### Function Names: Action + Subject

```typescript
// WRONG — vague or generic
function get(id: string) { ... }
function handle(data: unknown) { ... }
function process(record: QueueRecord) { ... }

// CORRECT — specific action + subject
function getOrderById(orderId: OrderId): Promise<Order | undefined> { ... }
function buildOrderSummary(order: Order, currency: Currency): OrderSummary { ... }
function markOrderAsShipped(orderId: OrderId, shippedAtEpochMs: number): Promise<void> { ... }
```

### Boolean Naming: `is/has/should/can` Prefix

```typescript
// WRONG
const recent = wasRecentlyUpdated(order)
const pending = firstPendingAt !== undefined

// CORRECT
const isRecentlyUpdated = wasRecentlyUpdated(order)
const hasPendingChange = firstPendingAt !== undefined
```

### Loop and Callback Variables: Name the Element

Name the iteration variable for what the collection holds, not `x`/`i`. Advisory tier — the plugin
surfaces these as `info`, so they do not fail CI, but fix them when you see them.

```typescript
// WRONG — single-char or generic names
orderIds.filter(x => x.length > 0)
for (const i of orderIds) { ... }
records.map(r => r.body)

// CORRECT — named for what the collection iterates
orderIds.filter(orderId => orderId.length > 0)
for (const orderId of orderIds) { ... }
records.map(record => record.body)
```

**Secondary benefit — scope hygiene.** Generic iteration names (`name`, `id`, `value`) collide more
easily with outer-scope identifiers than specific ones (`orderId`, `paymentMethod`); when both
bindings share a name the shadow is invisible at review. Specific names surface stale references the
type-checker can't.

### Index and Counter Variables: Name What They Walk

`i` tells the reader nothing. Name it for the collection it indexes or the quantity it counts:
`orderIndex`, `attempt`, `pageOffset`. Prefer `for…of` where the index is not needed.

```typescript
// WRONG
for (let i = 0; i < orderIds.length; i++) { upsert(orderIds[i]) }

// CORRECT
for (const orderId of orderIds) { upsert(orderId) }
```

## Readability Over Cleverness

```typescript
// WRONG — clever one-liner
const status = values.filter(value => value > 0n).length > 0 ? 'has-values' : 'empty'

// CORRECT — clear and scannable
const positiveValues = values.filter(value => value > 0n)
const status = positiveValues.length > 0 ? 'has-values' : 'empty'
```

## Explicit Over Implicit

`useExplicitLengthCheck` (Biome error) enforces the length case below; the null/undefined case is
review-only but expected.

```typescript
// WRONG — falsy check catches 0 and ''
if (value) { ... }
if (array.length) { ... }

// CORRECT — explicit checks
if (value !== null && value !== undefined) { ... }
if (array.length > 0) { ... }
```

## No Magic Numbers

Extract numeric literals to named constants (see also `agent-discipline.md`):

```typescript
// WRONG
if (now - firstPendingAt >= 3_600_000) { ... }

// CORRECT
const MAX_PENDING_WINDOW_SECONDS = 3600
const MILLISECONDS_PER_SECOND = 1000
if (now - firstPendingAt >= MAX_PENDING_WINDOW_SECONDS * MILLISECONDS_PER_SECOND) { ... }
```

**Acceptable inline**: universally understood values (`index + 1`, `array.slice(0, 1)`) and small,
self-evident arithmetic (`start * width`). The bar: would a reviewer have to guess what it means?

## `process.env` Access

Two layers, per the `noProcessEnv` scoping above.

### Source — read only at the composition root

Reading `process.env` in source is allowed (it is how deployment configuration reaches the process),
but funnel it through **one place per module** — the composition root (e.g. `dependencies.ts`) —
rather than scattering `process.env.X` through the logic. Factories take the value as an option and
validate it lazily, so the pure code never touches `process.env`:

```typescript
// In the module's composition root — the single place that reads env for this module
store: createPostgresOrderStore({
  client: databaseClient,
  connectionString: process.env.DATABASE_URL ?? '',
})
// store.ts then guards it lazily — the store logic itself never reads process.env.
```

### Tests — never read `process.env`

`noProcessEnv` is an **error** in `*.test.ts`. Inject the value instead (pass `connectionString`, an
injectable `now`, a fake client). A test that reaches for `process.env` couples to ambient state that
the injected-seam design exists to avoid.

## DRY & Reuse

See `broken-windows.md` for the duplication discipline: grep before writing, extract at the **third**
occurrence (not the first). Shared domain constants and interfaces live in the module that owns them
— e.g. a `types.ts` exporting `ORDER_STATUSES` that both the validator and the renderer import,
rather than each redefining the literal. There is no structural-duplication tool in this repo; the
check is grep + judgment at review.
