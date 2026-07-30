---
name: test-quality
description: |
  Self-contained guide to writing, reviewing, and maintaining high-quality tests with AI assistance.
  Defends against three failure modes: fig-leaf tests (pass without verifying behavior), evasion
  (existing tests weakened to mask real bugs), and self-description drift (a test file's comments or
  names claim a stronger guarantee than its assertions deliver). Its core discipline is empirical
  mutation review — break the implementation, confirm a test goes red, revert — not just reading
  tests. Router skill — loads narrow workflow files by task intent. Covers single-test writing,
  single-file review, suite-scale audit, failing-test response, and framework-specific pitfalls for
  Vitest and bun:test.
  Use when writing new tests, reviewing tests in a PR, auditing a test suite at scale, responding
  to a failing test, or auditing existing tests for quality.
paths:
  - "**/*.test.{ts,tsx}"

trigger_phrase:
  opus: "test quality writing reviewing"
  sonnet: "test quality writing reviewing vitest bun"
  haiku: "add a test fix this test test failing mock"
---
# Test Quality with AI

A test is a claim about behavior. The claim needs proof — a broken implementation must fail it. This skill defends against three failure modes that recur when AI assists with test writing:

1. **Fig-leaf tests** — tests that pass without verifying behavior, written so the agent can claim "I tested it" and check a box.
2. **Evasion** — existing tests modified to mask a real bug rather than fix the code.
3. **Self-description drift** — a test file's comments or names claim a stronger guarantee than its assertions deliver. The tests may be sound; the *description* misleads the next reader about what's actually guarded.

The skill is a **router**: it states the load-bearing principles, then dispatches you to the workflow file that matches what you're actually doing. Don't try to apply everything at once.

## The principles

These apply at every stage. Internalize them before reading any workflow.

1. **A test is a claim about behavior.** A broken implementation must fail it. If `return null` passes the test, the test is not testing.
2. **"What bug would this test catch?"** State it in one sentence per test. The sentence must name a *specific* failure mode — a particular line, condition, or contract violation — not a generic statement ("catches bugs where the function returns wrong values" is content-free). *This is the single highest-leverage discipline in this skill, and the one most prone to soft-floor evasion.* See `checklists/pre-claim.md` "Specific vs generic claims" for the falsifier.
3. **When a test fails, the default is the code is wrong, not the test.** Inverting that default requires written justification of the behavior change.
4. **Coverage is a floor, not a ceiling.** 100% coverage with permissive assertions is the fig-leaf endgame. **And line coverage is not branch coverage:** a `??`, `||`, or ternary line reads as *covered* when only one side ever executed. Never cite a line-coverage number as evidence that a branch is exercised — read the branch percentage, or better, mutate the branch and rerun (principle 5). The `configuredEnv ?? provider.defaultCredentialEnv` shape is the canonical trap: the line is green, the config-override side is untested.
5. **Prove the mutation; don't just imagine it — when running it is cheap.** The review discipline (`workflows/review-single.md` Step 2) asks you to *mentally* mutate the implementation and ask whether a test catches it. Mental mutation is a hypothesis, not a receipt, and it quietly reintroduces the "reasoning instead of evidence" failure mode. **Decision rule:** if the affected suite is fast and deterministic (pure logic, unit-level), *actually* apply the mutation — delete the branch or flip the operator, run the suite, confirm red, revert. If the suite is slow, flaky, or wide, use mental mutation to triage and schedule real mutation testing (Stryker) for the survivors. The empirical form is the "delete the implementation" stress test in `workflows/maintain-failing.md`; treat it as the default for cheap suites, not a rare diagnostic.

   **A surviving mutation is a question, not a finding.** Green after a mutation means one of two things: (a) the test has a gap, or (b) the code you mutated was redundant or dead. Distinguish before reporting — a "gap" that is actually dead code is a false positive, and the real finding is "delete this line." (Corollary: a test can also pass for the *wrong reason* — a per-tool budget test once went green-for-free because its setup magnitudes couldn't make the bug observable until the exhaustion direction was reversed. If a mutation won't go red, ask *why* before trusting the test.)
6. **Verify the test file's claims about itself, not just the code.** If a docstring says "each rule is guarded" or a name says "validates X", apply the same mutation you would apply to the code: break the specific thing the comment names, and confirm a test goes red. A comment that overclaims is a latent fig-leaf — it tells the next agent that coverage exists when it does not. (Worked case: a normalization module's docstring claimed "each dropped rule turns a test red"; two of its rules were no-ops, so removing them turned nothing red — the comment guaranteed coverage the assertions never delivered.)

## Router — pick your workflow

**Writing? Reviewing? Auditing? Maintaining?** Pick one. Identify what you're actually doing and load the matching workflow file before applying its discipline. Don't load workflows you aren't using.

| You are... | Load |
|---|---|
| About to **write a new test** | `workflows/generate.md` |
| **Reviewing tests** in a single PR or file | `workflows/review-single.md` |
| **Auditing a suite** of N test files at scale | `workflows/review-at-scale.md` |
| Responding to a **failing test** | `workflows/maintain-failing.md` |

Each workflow loads the checklists and references it needs. The router itself doesn't.

## Bundled tooling

This skill ships a grep-based Tier 1 pre-screen at `scripts/check-test-quality.sh`. It catches the deterministic fig-leaf signals (committed `.only`, `@ts-expect-error`, snapshot regenerations without inspection, empty catch blocks, weak assertions) without LLM analysis. The audit workflows reference it as their first step.

See `scripts/README.md` for invocation, CI integration examples, and tuning guidance.

```bash
./scripts/check-test-quality.sh                       # scan cwd
./scripts/check-test-quality.sh --diff origin/main..HEAD --strict  # CI gating
./scripts/check-test-quality.sh --json                # structured output
```

## Conditional framework references

Identify the framework before writing code that imports from it. AI training data is heavily Jest-weighted; without explicit anchoring agents reach for `jest.fn` / `jest.mock` even in Vitest or bun:test projects.

| Project framework | Load |
|---|---|
| Vitest (`vitest.config.ts`, `vitest` in package.json) | `references/vitest-patterns.md` |
| bun:test (imports from `bun:test`, `bunfig.toml`) | `references/bun-test-patterns.md` |
| Other / unclear | Read existing tests to identify; do not guess |

These references cover what AI tools commonly get wrong for each framework — namespaces, mock APIs, watch-mode behavior, async patterns, fake timers, snapshot conventions.

**Load a framework reference only in a workflow that *produces* test code** — `workflows/generate.md`, or `workflows/maintain-failing.md` when the fix edits a test. **A pure review produces findings, not code**: in `review-single`/`review-at-scale` the reference is a targeted lookup (does the diff misuse a framework API — `jest.fn` in a Vitest project, a missing `await` on `.resolves`, an unrestored spy?), not a default load. Pulling 250 lines of write-time mock/timer guidance into a review you're not writing code for is wasted context — the most common over-load in practice.

## Self-contained design

This skill does not link to or depend on other skills. All required content lives inside the skill tree. The router pattern keeps the always-loaded surface small; the linked files together cover everything a single skill would.

If this skill ever lifts into a dedicated test agent's system prompt, the agent loads SKILL.md + every workflow + every checklist + every reference. They are designed to read coherently when concatenated.

## File structure

```
test-quality/
├── SKILL.md                              this file — router only
├── workflows/
│   ├── generate.md                       writing a new test
│   ├── review-single.md                  reviewing one PR / file
│   ├── review-at-scale.md                auditing N files
│   └── maintain-failing.md               responding to a failing test
├── checklists/
│   ├── fig-leaf-signals.md               the list of detection patterns
│   ├── mock-antipatterns.md              five named mock anti-patterns
│   └── pre-claim.md                      before declaring "tested"
├── references/
│   ├── vitest-patterns.md                Vitest-specific pitfalls
│   ├── bun-test-patterns.md              bun:test-specific pitfalls
│   └── assertion-shape.md                toMatchObject vs toEqual vs toStrictEqual
└── scripts/
    ├── check-test-quality.sh             Tier 1 grep pre-screen
    └── README.md                         script invocation + CI integration
```

---

## Project notes

This skill diverges from the upstream `test-quality-with-ai` in a few
router-level ways, each earned from live reviews of this repo's suite (`search`,
`reports`, `config-schema`, `research-loop`, `quota`, `run-progress`) where a
mental-only discipline would have shipped a flawed review:

- **Principle 4** names the branch-vs-line coverage trap — a `??`/`||`/ternary
  line reads *covered* when only one side ran, so line coverage is not branch
  coverage (a near-miss on `search.ts:54`).
- **Principle 5** makes empirical mutation the default on cheap suites, and adds
  "a surviving mutation is a question, not a finding" — green can mean dead code,
  not a test gap (the `run-progress` no-op lines; the `quota` green-for-free test).
- **Failure mode 3 + principle 6** add self-description drift — a test file's
  prose claiming a guarantee its assertions do not deliver (`run-progress`'s
  docstring claimed "each dropped rule turns a test red"; two rules were no-ops).
- **Framework references** load only in code-producing workflows, not pure reviews.

Deeper changes still belong in the workflow files and are not yet made here:
promoting empirical mutation into `review-single.md` Step 2; a Stryker-first step
for `review-at-scale.md` on fast suites; a quality-vs-presence scope note; and a
"RED must fail on the assertion, not a setup crash" note in `generate.md`.
