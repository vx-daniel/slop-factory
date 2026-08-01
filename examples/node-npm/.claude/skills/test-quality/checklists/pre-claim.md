# Checklist: Before declaring "tested"

Before any agent (or human) claims a piece of work is "tested," every item on this list must be satisfied.

Single canonical pre-claim checklist. Referenced from `workflows/generate.md` and `workflows/review-single.md`.

## Tier 1 — automated

- [ ] **Tier 1 pre-screen passes.** `scripts/check-test-quality.sh --strict` against the test files (or `--diff` for the PR scope) returns exit 0. HIGH-severity grep findings resolved.

## Tier 2 — judgment

- [ ] **What bug would each test catch?** Stated in one sentence per test, naming a *specific* failure mode (a line, a condition, a contract violation). Generic claims do not pass this bar. See "Specific vs generic claims" below.
- [ ] **Mutation pass complete — run it if the suite is cheap.** For each test, at least one realistic
      mutation of the implementation has been applied and the test *watched* going red, then reverted.
      Mental mutation is the fallback for a slow or non-deterministic suite only, and it is a
      hypothesis rather than a receipt (see SKILL.md principle 5, "Prove the mutation; don't just
      imagine it"). If you fell back to mental, say so when you report — do not let "considered" be
      read as "verified".
- [ ] **TDD or equivalent confidence.** Either the test was written before the implementation and seen to fail, OR the implementation has been broken and the test observed failing in that broken state.
- [ ] **Tests run successfully on a clean working tree.** Not "tests look right" — tests have been executed and passed.
- [ ] **Edge cases covered.** Empty / null / undefined / boundary / error inputs each have a test, where applicable.
- [ ] **Contract surfaces have a canonical-shape lock.** If the code under test produces output consumed by downstream code, at least one test asserts the full shape with `toEqual` (or equivalent). See `references/assertion-shape.md`.
- [ ] **Mock setup justifiable.** Every mock can be explained in one sentence: why it's needed and what it removes. See `checklists/mock-antipatterns.md`.
- [ ] **No fig-leaf signals.** The patterns in `checklists/fig-leaf-signals.md` are clean for these tests.
- [ ] **Test names are scan-readable.** Verbose names rewritten for clarity ("should correctly return..." → "formats USD prices").
- [ ] **No `.skip` / `.todo` / `.only` left behind.** Tracking issues filed for anything intentionally deferred.
- [ ] **Framework conventions honored.** Imports from the actual framework, not a cross-framework slip (Jest API in Vitest project, etc.). See `references/vitest-patterns.md` or `references/bun-test-patterns.md`.

## Specific vs generic claims

The "what bug would this test catch?" discipline is the skill's highest-leverage check — and its softest floor. **Any test can be defended with a generic claim**:

> "Catches bugs where the function returns wrong values."

This is true. It is also content-free. It passes the "state one sentence" bar without saying anything. A fig-leaf test passes this check trivially.

The discipline only works if the claim is **specific enough to be falsifiable**. Specific means: it names *which* wrong value, or *which* condition, or *which* line of the implementation would have to change for the test to catch the bug.

### Examples

| Generic (fails the bar) | Specific (passes) |
|---|---|
| "Catches bugs where the function returns wrong values." | "Catches an off-by-one error in the bounds check on line 42 — `<` becoming `<=` would let one extra element through and break this assertion." |
| "Verifies the decoder works." | "Catches a missing field if `parseTemperature` returns `undefined` instead of a number — the `toEqual` lock would fail because expected has `temperature: 21.5` and actual would lack the key." |
| "Tests the happy path." | "Catches a regression where `formatPrice(5.99)` started returning `'5.990'` instead of `'$5.99'` — the literal expected string would mismatch." |
| "Ensures the function doesn't throw." | "Catches a NullPointerException if `user.profile` is undefined and the function fails to default — the test runs against a partial user object." |
| (Python) "Tests the parser handles input." | "Catches if `parse_date('2026-02-30')` raises `ValueError` instead of returning `None` — the test asserts `None`, not `pytest.raises`." |
| (Rust) "Verifies the result is correct." | "Catches if `compute_checksum(buf)` returns `Ok(wrong_value)` instead of `Ok(0xDEAD)` — the assertion locks the literal CRC, so any drift fails." |

The pattern: a specific claim names a mutation to the implementation that would cause the test to fail. A generic claim does not.

### The falsifier check

For each test's "what bug?" claim, ask:

1. **Could I name the specific line of the implementation that would have to change for this test to catch the bug?**
2. **Could I describe the mutation in one sentence?**
3. **Does the claim depend on the implementation actually doing something, or would `return null` also fail it?**

If the answer to any of these is "no" or "not really," the claim is generic. Restate or replace the test.

### Why this discipline is agent-honesty-dependent

This check has no procedural enforcement. An agent that wants to defend a fig-leaf test can produce a generic-sounding-specific claim ("catches the bug where line 42's bounds check is wrong") that's almost-but-not-quite specific. The skill cannot verify the claim's specificity from the outside; that requires reading the implementation alongside the test and checking whether the claimed mutation would actually fail the test.

**The discipline is honest only if the agent applies it honestly.** When reviewing your own tests with this check, the test is whether you can sit with the discomfort of admitting a claim is generic when it is. This is uncomfortable because the alternative — restating the test specifically, or admitting it's decorative and rewriting — costs effort the generic claim avoids. The skill's job is to name the failure mode and provide the falsifier; the agent's job is to use them.

A practical self-check: if a colleague reviewing your test asked "show me which specific line of the implementation would have to change for this test to catch the bug you claim it catches," could you point at it? If pointing requires hand-waving ("somewhere in the calculation"), the claim is generic.

## Binary state

"Tested" is a binary claim. Work either passes every item above and earns the claim, or it doesn't and the claim is unjustified.

Partial states have other names:
- **"Tests are written but failing"** — work in progress
- **"Tests pass but I haven't reviewed them adversarially"** — work near complete
- **"Tests pass but some edge cases are deferred"** — work shipping with known gaps; gaps must be tracked
- **"Tests pass and I've answered 'what bug would this catch?' for each"** — tested

The skill exists to defend the integrity of the "tested" claim. An agent that declares work tested without satisfying this checklist has made a claim it can't back.

## Cross-references

- `scripts/check-test-quality.sh` — automates Tier 1
- `checklists/fig-leaf-signals.md` — detection patterns referenced above
- `checklists/mock-antipatterns.md` — mock-specific patterns referenced above
- `references/assertion-shape.md` — canonical-shape lock detail
- Workflow this is the final step of: `workflows/generate.md` (writing) or `workflows/review-single.md` (reviewing)
