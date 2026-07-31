# Assertion shape — `toMatchObject` vs `toEqual` vs `toStrictEqual`

Framework-agnostic reference for an anti-pattern that bites contract libraries, public APIs, and any code whose output shape is itself a contract. Load this when reviewing or writing tests whose subject produces structured output consumed by downstream code or external users.

## The problem in one sentence

`toMatchObject` is permissive in both directions: extra fields pass silently, and asserted-but-missing fields are the only thing it catches. On contract surfaces, this lets shape drift ship invisibly.

## The three matchers compared

| Matcher | Extra fields | Missing asserted fields | Missing unasserted fields | Class identity |
|---|---|---|---|---|
| `toMatchObject` | passes (silent) | fails | passes (silent) | ignored |
| `toEqual` | fails | fails | fails | ignored |
| `toStrictEqual` | fails | fails | fails | enforced |

**`toMatchObject(expected)`** — checks that `actual` contains every field in `expected` with matching values. Any field present in `actual` but not in `expected` is ignored. Any field in `expected` not in `actual` causes failure.

**`toEqual(expected)`** — checks that `actual` and `expected` have the same fields recursively, with matching values. Fields present in either but not both cause failure. Treats `undefined` properties as equivalent to missing properties (e.g. `{ a: 1, b: undefined }` equals `{ a: 1 }`).

**`toStrictEqual(expected)`** — like `toEqual` but stricter: class identity matters (`Foo` ≠ `Bar` even with identical fields), undefined-vs-missing distinction is enforced.

## The failure modes

### Extra-field drift

Production code starts emitting a new field; nothing in the test suite asserts the contract is fixed; the new field silently becomes part of the shipped output.

```js
// production change adds a debug field — accidentally exposed to consumers
function decode(payload) {
  return {
    deviceId: parseDeviceId(payload),
    temp: parseTemp(payload),
    debug: { rawBytes: payload },  // new — not intended for public consumption
  }
}

// existing test passes silently
expect(decode(payload)).toMatchObject({
  deviceId: 'abc-123',
  temp: 21.5,
})
// `debug` field is now part of the de-facto contract; downstream consumers
// may start depending on it; rolling it back becomes a breaking change.
```

`toEqual` would catch this: the actual object has a field the expected does not.

### Missing-field drift

Production code stops emitting a field; only tests that *assert* the field catch it; tests using `toMatchObject` against a partial expectation pass.

```js
// production change drops a documented field
function decode(payload) {
  return {
    deviceId: parseDeviceId(payload),
    // temp removed — was part of the contract
  }
}

// existing test that didn't assert temp passes silently
expect(decode(payload)).toMatchObject({
  deviceId: 'abc-123',
})
// the contract is now broken for any consumer reading temp
```

`toEqual` would catch this only if the test's expected object included `temp`. Both `toMatchObject` and `toEqual` would catch it if `temp` is asserted; only `toEqual` catches the case where the test happens not to mention that specific field but the canonical contract does.

This is why the canonical-shape lock matters (see "The rule" below).

### Class-identity drift

Production code starts returning plain objects where it used to return class instances (or vice versa). Methods stop working; instanceof checks fail; only `toStrictEqual` catches it.

```js
class Decoded { constructor(d) { Object.assign(this, d) } }

// before:
function decode(p) { return new Decoded({ deviceId: 'x' }) }
// after:
function decode(p) { return { deviceId: 'x' } }

expect(decode(p)).toEqual({ deviceId: 'x' })          // passes — class ignored
expect(decode(p)).toStrictEqual(new Decoded({ ... })) // fails
```

Class identity matters when downstream code does `instanceof` checks or calls methods. For plain-data libraries (decoders, serializers, JSON shapes) class identity is usually irrelevant — `toEqual` is enough.

## When each matcher is appropriate

### `toMatchObject` — appropriate uses

- **Partial-shape focus**: asserting that one specific field has a specific value, where the rest of the object is irrelevant to this test. Example: a deeply-nested response where you care about exactly one nested value.
- **Tests that intentionally tolerate extra fields**: when the contract explicitly allows additional fields (e.g., extensible config objects).
- **One of many tests on the same subject**: when the canonical shape is locked by a separate `toEqual` test (see below), the per-field tests can use `toMatchObject` for focus.

**Anti-use: as the *only* shape assertion on a contract surface.** If your decoder/serializer/API has tests that all use `toMatchObject`, no test is locking the full canonical shape. Drift in both directions ships invisibly.

### `toEqual` — appropriate uses (and the rule)

- **Locking the canonical shape**: at least one test per contract surface should assert the full output shape with `toEqual`. This is the per-surface "what is the contract?" test.
- **Equality with semantic identity**: when you care that the result matches a known reference object exactly, including the absence of unexpected fields.
- **Most cases by default**: when in doubt, prefer `toEqual` over `toMatchObject`. The cost (more verbose expected values) is small; the benefit (catches drift in both directions) is meaningful.

**The rule for contract surfaces:** for each public-output function — decoder, serializer, API handler, formatter, anything whose output is consumed by code outside the test — at least one test must `toEqual` the full canonical output for a representative input. Other tests on the same surface can use `toMatchObject` for partial focus once the canonical shape is locked elsewhere.

This is the lowest-cost ratchet that catches contract drift.

### `toStrictEqual` — appropriate uses

- **Class instances matter**: the production code returns class instances and consumers do `instanceof` checks or call methods.
- **`undefined` vs missing matters**: rare, but real when serializing to formats that distinguish them (e.g., GraphQL nullability).
- **You want the maximum strictness ratchet** and the cost is bearable.

For most plain-data tests, `toEqual` is the right default. `toStrictEqual` is for when you've identified a specific class-identity or undefined-vs-missing concern.

## Detection patterns

When auditing a test suite, flag the following:

1. **Suite-wide `toMatchObject` on a contract surface.** Grep ratio: `rg -c toMatchObject tests/ | rg -c toEqual tests/`. If the first is >> the second on a public-output codebase, the canonical-shape lock is probably missing.

2. **No `toEqual` per public-output function.** For each exported function whose output is consumed externally, search for a test that locks the full shape with `toEqual`. Absence is a finding.

3. **`toMatchObject` on freshly-added contract output.** When a PR adds a new exported function returning structured data, the first test should use `toEqual` to pin the canonical shape. A PR that adds only `toMatchObject` tests for new contract output is shipping an unlocked contract.

4. **`toMatchObject({})` or `toMatchObject({} as any)`.** Asserts nothing about the shape at all. Pure fig-leaf.

## Worked example — auditing a decoder library

For a library that decodes binary payloads into JSON objects (`decode(bytes) → { ... }`), each decoder is a contract surface. The audit pattern:

For each decoder `decodeFoo`:
- Is there at least one test asserting `toEqual(canonicalOutput)` for a representative input? If no → S2 finding.
- Are there tests asserting individual fields with `toMatchObject({ specificField: value })`? Fine, as long as the canonical-lock test exists.
- Are there tests asserting "produces correct latitude" with `toMatchObject({ latitude: <range check> })` but no test pinning the literal value? S2 finding — combined with weak-assertion smell (see `checklists/fig-leaf-signals.md`).

Recommended ratchet for a suite missing canonical locks: file one issue scoped to "add `toEqual` canonical-output test per public decoder," batched by category (GPS, settings, telemetry, etc.). Each individual test is ~5-15 lines; the per-decoder cost is small.

## When the canonical shape is awkward to assert

Sometimes the canonical output is large enough that writing the literal expected value by hand is painful. Two reasonable patterns:

**1. Inline snapshot for the canonical shape.**
```js
expect(decode(canonicalPayload)).toMatchInlineSnapshot(`
  {
    "deviceId": "abc-123",
    "temp": 21.5,
    "humidity": 45,
    "timestamp": 1700000000,
  }
`)
```
Inline keeps the expected value in front of the reviewer in PRs. Failures are visible diffs.

**2. Fixture-loaded reference.**
```js
import { canonicalDecodeFoo } from './fixtures/canonical-outputs'

expect(decode(canonicalPayload)).toEqual(canonicalDecodeFoo)
```
The fixture file is the single source of truth for the canonical shape per surface. Changes to it require explicit review.

**Avoid**: external `toMatchSnapshot()` against a `.snap` file that nobody reads. That's the snapshot anti-pattern, not the canonical lock.

## Cross-framework notes

| Framework | `toMatchObject` | `toEqual` | `toStrictEqual` |
|---|---|---|---|
| Vitest | yes | yes | yes |
| bun:test | yes | yes | yes |
| Jest | yes | yes | yes |

Behavior is consistent across the three. The pattern applies regardless of framework.

## Cross-references

- `checklists/fig-leaf-signals.md` — broader detection patterns including assertion-strength smells
- `workflows/review-at-scale.md` — applies this reference during suite audits when the contract-surface lens fits
- `workflows/generate.md` — applies this reference when writing tests for new contract surfaces
- `scripts/check-test-quality.sh` — Tier 1 script does NOT cover the `toMatchObject` ratio check; AST-level escalation; see this file for the manual / Tier 2 check
