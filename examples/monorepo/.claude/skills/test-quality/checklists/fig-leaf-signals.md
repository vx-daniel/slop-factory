# Checklist: Fig-leaf signals

Single canonical list of detection patterns. Referenced from the review workflows; not duplicated elsewhere in the skill.

A test exhibiting any of these may still be legitimate — context matters. Multiple signals on the same test or suite is diagnostic of fig-leaf accumulation.

## Tier 1 — script-detectable (grep)

These are caught by `scripts/check-test-quality.sh` without LLM analysis. They're listed here for the agent's awareness and for use when the script isn't available.

- [ ] **`.skip()` on test/it/describe** — disabled test in committed code. Must have tracking issue or be re-enabled.
- [ ] **`.todo()` on test/it/describe** — unimplemented test. Should have tracking issue.
- [ ] **`.only()` on test/it/describe** — silently skips every other test in the file. MUST be removed before merge.
- [ ] **`@ts-expect-error` in test files** — suppresses type errors; verify the test isn't hiding a real problem.
- [ ] **`@ts-ignore` in test files** — prefer `@ts-expect-error` (fails when no longer needed); investigate the underlying type issue.
- [ ] **Empty catch blocks** in test bodies: `catch (e) {}` or `catch {}` — swallows assertion errors.
- [ ] **Auto-snapshot-update flag** (`--update-snapshots`, `-u`) in test commands — snapshots regenerate without inspection.
- [ ] **Snapshot files modified without sibling source changes** — likely regenerated without inspecting the diff.
- [ ] **Coverage threshold reductions** in config files (without justification commit message).

## Tier 2 — judgment-required (LLM or human)

These require understanding context — test block scope, mock proportion, semantic correctness. Not catchable by grep.

### Assertion-strength

- [ ] **`expect(x).toBeDefined()` as the only assertion** in a test — verifies presence, not correctness.
- [ ] **`expect(x).toBeTruthy()` / `.toBeFalsy()`** — passes for any non-empty/empty value. Prefer specific equality.
- [ ] **`expect(() => fn()).not.toThrow()` as the only assertion** — verifies no crash, not correct output.
- [ ] **Tautological assertions** — expected value computed by the same logic as the implementation.
- [ ] **Assertions on stringified output without parsing** — `expect(serialize(x)).toContain('expected')` instead of `expect(parse(serialize(x))).toEqual(x)`.

### Shape and contract

- [ ] **`toMatchObject` as the only shape assertion on a contract surface** — see `references/assertion-shape.md`. Permissive in both directions; lets contract drift ship invisibly.
- [ ] **No canonical-shape `toEqual` per public output function** — no test locks the full output contract.
- [ ] **`toMatchObject({})` or `toMatchObject({} as any)`** — asserts nothing.

### Mock patterns

- [ ] **Assertions on mock existence** (`*-mock` test IDs, `toHaveBeenCalled` as the only assertion) — tests the mock, not the code. See `checklists/mock-antipatterns.md`.
- [ ] **Mock setup > 50% of test body** — test is solving the wrong problem; consider integration test.
- [ ] **Methods in production classes only called from test files** — see `checklists/mock-antipatterns.md`.
- [ ] **Mock missing methods the real component has** — partial mock; production code may hit the missing surface.

### Structural

- [ ] **Test name describes implementation, not behavior** — "should call `parseDate` then `formatOutput`" vs "formats dates as ISO 8601."
- [ ] **No edge cases tested** — only happy path; no empty/null/boundary/error inputs.
- [ ] **Cannot answer "what bug would this test catch?" in one sentence** — decorative test.
- [ ] **Test that has never been seen to fail against broken code** — there's no input that would cause it to fail.

### Test isolation

- [ ] **Tests pass alone but fail in suite** — shared state across tests.
- [ ] **Flaky test marked `.retry()` instead of fixed** — retry-until-pass is anti-pattern.
- [ ] **Real `setTimeout` waits in tests** — flake source; use fake timers or injected clock.
- [ ] **Tests depend on `Date.now()` / `Math.random()` without pinning** — non-deterministic.

## Severity guidance

When reporting fig-leaf signals:

- **HIGH**: signals from the script's Tier 1 list (deterministic, no judgment required). Also: `toMatchObject({})`, mock-existence assertions on production-critical code, tests that have never failed.
- **MEDIUM**: judgment-required signals where the smell is clear in context (toMatchObject-only on a known contract surface, mock setup > 50%, tautological assertion).
- **LOW**: judgment-required signals where context might justify the pattern (toBeDefined as part of broader assertions, `not.toThrow` paired with output check, single-test files for low-risk simple functions).

LOW findings are advisory — never gating, never sole basis for blocking a PR.

## Cross-references

- `scripts/check-test-quality.sh` — automates the Tier 1 portion
- `checklists/mock-antipatterns.md` — the five named mock anti-patterns in detail
- `references/assertion-shape.md` — `toMatchObject` / `toEqual` / `toStrictEqual` choice
- `workflows/review-single.md` — uses this checklist per file
- `workflows/review-at-scale.md` — uses this checklist as the reader prompt's vocabulary
