# Workflow: Maintain — when a test fails

Use this workflow when a previously-passing test now fails. Defends against test evasion — the highest-stakes moment for the second failure mode the skill addresses. The temptation to weaken the assertion is real and immediate. Resist it.

## Step 0 — Load the framework reference (if fixing the test, not just the code)

**If your investigation may lead to modifying test code** (fake timers, mock restoration, snapshot inspection, async patterns), load the matching framework reference first. Framework-specific behaviors are the difference between a correct fix and silent breakage on other tests in the suite.

- Vitest project → `references/vitest-patterns.md`
- bun:test project → `references/bun-test-patterns.md` *(especially the `mock.module` process-global section — failing tests are often a symptom of cross-file mock pollution)*

If your investigation will only modify production code (the test stays as-is), this step is optional.

## The default

When a test fails: **the code is wrong, the test is right.**

Inverting this default — changing the test instead of the code — requires a written justification of the behavior change. The justification names what behavior changed and why the test's previous assertion is no longer correct. No exceptions, no shortcuts.

## Investigation order

Before any change — to either the code or the test — investigate:

1. **Read the failure message and stack trace.** Often points directly at the bug.
2. **Run the test in isolation.** If it passes alone but fails in the suite, you have a test isolation problem — see "Test isolation" below.
3. **Read the production code change that broke it.** What behavior changed? Is the change intentional?
4. **If intentional**: update the test (legitimate path — see next section). Document the behavior change.
5. **If unintentional**: the production change has a bug. Fix the code.
6. **If unclear**: revert the production change locally. Does the test pass against the previous version? That confirms the production change is the cause.

The investigation is the work. The change — whichever side it's on — follows the investigation.

## Legitimate reasons to modify a failing test

- **Intentional behavior change.** The product requirement changed; the test asserted the old behavior. Update the test, cite the requirement.
- **Previously undefined behavior pinned.** The test asserted a specific behavior that was not actually a contract; the new code chose a different equally-valid behavior. Update the test to match the new contract; document that the previous behavior was incidental.
- **Environment moved.** A framework version, library version, or runtime moved; the test asserted a now-changed environment shape (e.g., a deprecated error message string). Update the test to match the new environment; cite the version change.
- **The test had a bug.** The test itself was incorrect — for example, it asserted on a hash that depended on insertion order in a Set. Fix the test's bug; verify the test still fails against the original target bug.

In every legitimate case, the test is being made **more correct**, not weaker. The new assertion is at least as specific as the old one.

## Illegitimate reasons — always wrong

- **"Make the test pass"** without identifying the root cause. This is evasion in pure form.
- **Loosening an assertion** because the value drifted. Old: `expect(x).toBe(42)`. New: `expect(x).toBeGreaterThan(0)`. The drift is the bug; the looser assertion hides it.
- **Adding `try/catch` around the assertion** so the failure is swallowed.
- **Increasing a numeric tolerance** without analyzing why the result drifted.
- **Regenerating a snapshot** without reading the diff to confirm the change is correct.
- **Removing a test** because "it's no longer relevant" without verifying that.
- **Adding `.skip` / `.todo`** to a previously-passing test.
- **Replacing `toEqual` with `toMatchObject`** to silence "extra field" failures. See `references/assertion-shape.md` — that "extra field" is contract drift, not test fragility.

If any of these is your first instinct, stop. Investigate the code change that broke the test. The test is telling you something.

## The "delete the implementation" stress test

Periodically — when reviewing a test suite, during a code audit, or when suspicious of a particular module — delete the body of a function and run the tests. If any tests still pass, those tests are decorative. The function could be replaced with nothing and the test suite would not catch it.

This is not a workflow ritual; it's a diagnostic. Use it when you suspect fig-leaf accumulation. Run it on a branch and revert.

Specifically when applied to a failing test: if you've "fixed" a failing test by weakening it, run this check on the function it tests. If the weakened test passes against a stubbed-out implementation, the weakening was evasion — revert.

## Flake-handling discipline

A flaky test is a bug. Not a nuisance. Not "intermittent." A bug.

**Anti-pattern:** retry-until-pass. Marking tests as `.retry(3)`, adding global retry logic, or simply re-running CI until green. Every retry hides one bit of information about the system's actual reliability.

**Discipline:**
- A flaky test gets prioritized. Either fix the underlying nondeterminism or remove the test until it can be made reliable.
- Pin time: `vi.useFakeTimers` (Vitest), or inject a clock dependency (bun:test, which lacks fake timers as of this writing). See framework references.
- Pin randomness: seeded RNG, no real `Math.random` in tests.
- Pin order: tests must not depend on previous tests' side effects.
- Pin async: `await` every promise, including in setup/teardown. `await Promise.resolve()` is sometimes needed to flush microtasks.

## Test isolation — when tests interact

Some failures only happen in the full suite, not in isolation. The cause is shared state across tests.

Sources of shared state:
- Module-level singletons (a class instance defined at module load)
- Mutated imports (a module that gets monkey-patched in test setup but not restored)
- Environment variables that one test sets and another reads
- Process-global mocks (notably bun:test's `mock.module` — see `references/bun-test-patterns.md`)
- File system state (a temp directory not cleaned up)
- Database state in integration tests

The fix is always: restore state at the end of each test. Use `beforeEach` to put the system in a known state; use `afterEach` to tear down. If your framework's mock library doesn't auto-restore, configure it to (Vitest: `restoreMocks: true`).

For bun:test specifically: `mock.module` is process-global and persists across test files. Load `references/bun-test-patterns.md` for the full surface rule and DI-preferred alternative.

## When the failing test is fragile by design

Sometimes the test really is wrong — overly coupled to implementation, asserting on incidental detail. The fix is to rewrite the test, not modify it incrementally.

Signal: the test broke on every recent refactor despite unchanged behavior. That's implementation coupling. Rewrite to assert on the public contract (inputs → outputs, observable side effects), not on the internal path.

Process:
1. Identify the behavior the test was trying to verify (read the test name, the comments, the surrounding context).
2. Write a new test that verifies that behavior at the public-contract level.
3. Watch the new test fail against the broken impl (confirms it tests behavior).
4. Verify the new test passes against the correct impl.
5. Delete the old test.

This is rewriting, not weakening. The new test is at least as adversarial as the old one would have been if it weren't implementation-coupled.

## Cross-references

- Principles and router: `SKILL.md`
- Adversarial review when reviewing the fix: `workflows/review-single.md`
- Why "code is wrong by default" matters at scale: `workflows/review-at-scale.md`
- Detection patterns to surface during investigation: `checklists/fig-leaf-signals.md`
- Mock-specific patterns: `checklists/mock-antipatterns.md`
- Contract-drift via assertion changes: `references/assertion-shape.md`
- Framework-specific time/randomness handling: `references/vitest-patterns.md`, `references/bun-test-patterns.md`
