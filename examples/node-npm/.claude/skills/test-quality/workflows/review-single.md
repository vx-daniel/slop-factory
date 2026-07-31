# Workflow: Review single — one file or one PR

Use this workflow when reviewing tests in a single PR or a small number of files (≤5). Defends against fig-leaf tests that have already been written.

For larger audits (>5 files), load `workflows/review-at-scale.md` instead — the mental mutation discipline doesn't scale to N files serially.

The mode here is adversarial. The default question is not "does this test pass?" but "what's the dumbest implementation that would still pass this test?"

## Step 1 — Tier 1 grep pass

Run the bundled script first. It catches deterministic signals (`.only`, `@ts-expect-error`, empty catch blocks, etc.) without judgment.

```bash
# for a PR
./scripts/check-test-quality.sh --diff origin/main..HEAD

# for a specific file or directory
./scripts/check-test-quality.sh path/to/file.test.ts
./scripts/check-test-quality.sh tests/
```

Address any HIGH-severity findings before continuing with the deeper review. They're cheap to fix and resolving them removes noise from the rest of the review.

## Step 2 — The mental mutation discipline

The single highest-leverage technique. For each test, imagine specific mutations to the implementation. Does any test catch them?

**Mutations to try mentally:**
- Replace the function body with `return null`, `return ""`, `return []`, `return 0`, or `return true`.
- Flip a comparison operator: `>` → `>=`, `===` → `!==`.
- Off-by-one: change `i < n` to `i <= n` or `i < n - 1`.
- Skip an array element: `array.slice(1)` instead of `array`.
- Swap arguments: `compare(a, b)` → `compare(b, a)`.
- Always-true / always-false: replace a condition with `true` or `false`.
- Drop an error path: replace `throw new Error(...)` with `return undefined`.

For each mutation that would clearly break the function's contract — does any test fail? If not, the test suite has a gap. Note it; surface in the review.

The formal version of this technique is **mutation testing** (Stryker for JS/TS). The mental discipline produces a meaningful fraction of mutation testing's value without the setup cost — exact proportion depends on suite size and reviewer thoroughness, and no rigorous study has been cited; Stryker's published bug-detection numbers are the source of truth for the formal approach. The mental discipline's value is that it costs zero infrastructure, so it can be applied during code review every time, not just on scheduled runs.

## Step 3 — Apply the checklists

The Tier 2 (judgment-required) signals are all in `checklists/fig-leaf-signals.md`. Walk through that list against each test under review. Don't re-state the patterns here; load the checklist.

Mock-specific patterns: `checklists/mock-antipatterns.md`. Five named patterns with violation/fix/detection.

Contract-surface check: if the code under test produces structured output for downstream consumption, load `references/assertion-shape.md` and check whether the canonical-shape lock exists. `toMatchObject`-only on a contract surface is a structural S2-level finding.

## Step 4 — Behavior vs implementation testing

Ask: "would this test fail if the internals changed but the output stayed correct?" If yes, the test is coupled to implementation.

Signs of implementation coupling:
- Asserting on the exact sequence of mock calls (when only the final state matters)
- Asserting on private method invocation
- Asserting on internal state shapes the public API doesn't expose
- Tests that break on every refactor despite unchanged behavior

These tests punish good code (refactors break them) and protect bad code (because they verify implementation paths, not contracts). Flag in the review.

## Step 5 — Coverage gaming detection

Tests written purely to hit lines are not tests. Signs:

- Tests that construct objects but assert nothing meaningful
- Tests that exercise a code path but only assert it didn't crash
- Tests with no failure mode — there's no input value that would cause them to fail

Coverage is a floor. If a line is covered only by tests with weak assertions, treat the line as uncovered for review purposes.

## Step 6 — Test names as documentation

A test name describes the behavior verified. Long names with extra qualifiers are noise.

```
WEAK:   "should correctly return the formatted price string when given a
         valid positive number and a supported currency code"

STRONG: "formats USD prices"
        "throws for negative amounts"
        "returns empty array when no items match"
```

The test name should be readable at the speed of skimming test output. AI tends to produce verbose names because the surrounding code is verbose. Suggest rewrites for scan-speed.

## Step 7 — Snapshot anti-patterns

Snapshot tests are powerful when used narrowly and dangerous when used broadly.

**Acceptable uses:**
- Small, structural assertions (a parsed AST node, an error message format, a formatted output)
- Inline snapshots (`toMatchInlineSnapshot`) where the expected value is visible in the test file

**Anti-patterns:**
- `toMatchSnapshot` against arbitrary large outputs — codifies whatever-comes-out as expected
- Regenerating a snapshot to "make the test pass" without reading the diff
- Snapshots of UI trees that change on every styling tweak (creates change-fatigue)

When in doubt, prefer specific assertions over snapshots. A snapshot that broke because of an unrelated change teaches noise discipline; a specific assertion that broke because of a real behavior change teaches signal.

## Step 8 — When mocks signal deeper issues

Some patterns indicate the test suite is solving the wrong problem rather than just having a weak test. Detail in `checklists/mock-antipatterns.md` "When mocks signal deeper issues." Warning signs:

- Mock setup > 50% of test code
- Mocks missing methods real components have
- Test breaks when mock implementation changes
- Can't explain why each mock is needed

The question to ask: "should this be an integration test with real components?"

## Property-based testing — when it's primary, not advisory

The default presentation of property-based testing as "an escape hatch from tautology-prone code" undersells it for a specific class of code: **structural transformers** (parsers, decoders, serializers, encoders, format converters, codecs).

For structural-transformer code under review, property-based testing is the **primary** testing discipline. Example unit tests can't characterize an infinite or near-infinite input space; they sample it. Property-based testing tests an invariant the function must satisfy regardless of input. Common properties for this domain:

- **Round-trip**: `decode(encode(x)) == x` for all valid `x`
- **Type-shape**: output has known fields regardless of which input path was taken
- **Bounded size**: output length is a function of input length
- **Idempotence**: `normalize(normalize(x)) == normalize(x)`
- **Commutativity / associativity** where applicable

When reviewing tests on a structural-transformer module, flag the **absence** of property tests as a structural gap, not just per-test fig-leaves. The presence of `toEqual` canonical locks per surface (from `references/assertion-shape.md`) is necessary but not sufficient — locks pin specific examples; properties characterize the contract.

Tools: `fast-check` (JS/TS), `hypothesis` (Python), `proptest` (Rust), `Hedgehog` (Haskell). For projects without these, "consider adopting fast-check / equivalent" is itself a valid audit finding.

## Briefly noted (other techniques)

- **Mutation testing** (Stryker for JS/TS): the formal version of the mental mutation discipline. Run periodically; not on every commit.
- **Fuzz testing**: brute-force input variation against properties. Useful for parsers and protocol implementations as a step beyond hand-curated property tests.

## Reporting findings

For each finding:
- Cite `file:line`.
- Name the specific pattern (from `checklists/fig-leaf-signals.md` vocabulary).
- Severity: HIGH (must fix), MEDIUM (structural risk), LOW (advisory).
- Suggested fix in one paragraph.

For a PR review, post a single comment per file or one comment per logical change. Don't fragment.

Use `checklists/pre-claim.md` as the gating check: if the tests can't satisfy that list after the review, the PR should not merge in its current shape.

## Quick-reference: red flags

When you encounter these, stop and reassess:

- Assertion checks for mock existence without verifying behavior
- A method on a production class is only called by tests
- Mock setup is more than 50% of the test body
- Test fails when the mock implementation changes (mock-coupled)
- Cannot explain why a specific mock is necessary
- Mocking "just to be safe" with no specific reason
- Mock is missing methods that the real component has
- A previously-passing test now fails — see `workflows/maintain-failing.md`
- "100% coverage" with no edge-case tests
- Test name describes the implementation, not the behavior
- Cannot answer "what bug would this test catch?" in one sentence

## Cross-references

- Principles and router: `SKILL.md`
- Detection patterns: `checklists/fig-leaf-signals.md`
- Mock anti-patterns: `checklists/mock-antipatterns.md`
- Pre-claim gate: `checklists/pre-claim.md`
- Contract surfaces: `references/assertion-shape.md`
- Larger audits: `workflows/review-at-scale.md`
- Test failing during review: `workflows/maintain-failing.md`
- Framework specifics: `references/vitest-patterns.md`, `references/bun-test-patterns.md`
- Tier 1 grep script: `scripts/check-test-quality.sh`
