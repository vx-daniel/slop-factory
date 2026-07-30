# Workflow: Generate — writing a new test

Use this workflow when about to write a new test or test file. Defends against fig-leaf tests at the source — written so the test would actually catch the bug it claims to catch.

## Step 0 — Load the framework reference

**Before writing any test code, identify the test framework and load the matching reference.** AI training data is heavily Jest-weighted; without explicit anchoring, agents reach for `jest.fn` / `jest.mock` even in Vitest or bun:test projects. Wrong-API code passes the agent's self-review but fails at runtime.

- Vitest project (`vitest.config.ts`, `vitest` in package.json) → load `references/vitest-patterns.md`
- bun:test project (imports from `bun:test`, `bunfig.toml`) → load `references/bun-test-patterns.md`
- Other framework (Jest, etc.) — read the existing test imports; do not assume Vitest patterns work

Do not proceed to Step 1 until the framework reference is loaded. This is a hard step, not advisory.

## TDD as default

Tests are part of implementation, not a checkbox after.

```
1. Write failing test (RED)
2. Watch it fail against real code (confirms it tests behavior, not mocks)
3. Implement minimal code (GREEN)
4. Refactor
5. THEN claim complete
```

If you write the implementation first, then the tests, you have already given up most of TDD's protection against testing mock behavior. The test exists in a world where the implementation already passes; you have to actively imagine what would break it. With TDD the broken state is the starting point.

**Watching it fail matters.** A test that has never been seen to fail against broken code is not yet known to be a test. The fail step is empirical evidence the assertion is load-bearing.

## Self-acquired context

The AI-coding guidance "provide context to the AI" assumes a user feeding context to an external model. When the agent is the AI, the agent must self-acquire that context before writing tests.

**Pre-write checklist the agent runs on itself:**

1. **Read the file under test.** Not just exports — read the implementation. The test's job is to verify behavior; you cannot verify behavior you have not understood. Skipping this step is the most common cause of fig-leaf tests.

2. **Read 1-2 sibling tests for pattern and style.** Conventions matter: `test` vs `it`, `describe` block structure, fixture builders, naming style. Match what's there unless there's a reason not to.

3. **Read the framework config.** `vitest.config.ts`, `bunfig.toml`, `jest.config.js`, package.json `test` script, `tsconfig.json` for type-checking expectations. Configuration affects which imports are needed and which globals exist.

4. **Framework reference is already loaded** (Step 0). Use it for the API names and patterns you're about to write.

5. **Read the type definitions for any external dependency you'll mock.** A mock must match the real shape, not the shape you imagine. See `checklists/mock-antipatterns.md` #4 (incomplete mock data structures).

## Prompt-as-self-direction

When the agent is generating tests, the implicit "prompt" is the agent's own task framing. Apply prompt-design principles to your own internal direction:

**Demand edge cases explicitly.** A function that takes a list must be tested with: empty list, single element, many elements, list with null/undefined entries, very large list (boundary). A function that takes a string: empty, whitespace-only, very long, with special characters, with unicode. A function that takes a number: zero, negative, very large, NaN, Infinity, decimal precision.

If the agent's framing is "write tests for `createUser`", the result is a single happy-path test. The framing must be "write tests for `createUser` covering: missing required fields, invalid email format, duplicate email rejection, successful creation, password hashing before storage." Specificity in framing produces specificity in tests.

**Name framework features.** Reach for the right tool:
- Parameterized tests across many inputs → `test.each`
- Small structural assertions → inline snapshots (`toMatchInlineSnapshot`)
- Async with promises → `.resolves` / `.rejects`
- Async with callbacks → `expect.assertions(n)` to ensure the callback actually ran
- Time-dependent code → fake timers (Vitest) or injected clock (bun:test)

See the loaded framework reference for the exact API.

**Set constraints.** State what NOT to do up front:
- "No module-level mocking unless justified"
- "No snapshot tests for arbitrary output"
- "Don't mock the function under test's dependencies unless they perform real I/O"
- "Use realistic test data, not `'test'` / `'foo'` / `'bar'`"

**Reference examples.** "Match the style of `auth.test.ts`" works better than describing conventions verbatim — naming, structure, and assertion style get picked up implicitly.

## Mock strategy at generation time

Mocks are isolation tools. The wrong mock breaks the test's ability to catch real bugs.

**Before mocking anything**, apply the discipline from `checklists/mock-antipatterns.md`:

1. List the method's side effects (DB writes, file I/O, API calls, state mutations).
2. Identify what the test actually needs to verify.
3. Mock ONLY external/slow operations. Preserve the side effects the test depends on.
4. If unsure what the test needs, run with the real implementation FIRST. Observe required behavior. THEN mock minimally at the lowest level.

Five named anti-patterns to avoid at generation time — see `checklists/mock-antipatterns.md` for full violation/fix/detection content:

1. **Testing mock behavior** — assertions on mock existence
2. **Test-only methods in production** — never add a method only called from tests
3. **Mocking without understanding** — list side effects, mock minimally
4. **Incomplete mock data structures** — include all fields from the real API
5. **Tests as afterthought** — TDD, not retrofit

## Contract-surface awareness

If the function you're testing produces structured output consumed by downstream code or external users (decoder, parser, serializer, API handler, formatter, public type), the output shape is itself a contract.

**Load `references/assertion-shape.md`** for the `toMatchObject` / `toEqual` / `toStrictEqual` distinction.

**Rule**: at least one test for this surface must lock the canonical output shape with `toEqual` (or equivalent exact-match assertion). Other tests can use `toMatchObject` for partial-shape focus once the canonical lock exists.

If you write only `toMatchObject` tests for a new contract surface, you've shipped an unlocked contract. Drift in either direction (added field, removed field) will pass silently.

## Generate → run → review

Always run before claiming done. AI-generated test code has import errors, undefined function references, wrong API names, and incorrect assertions that only surface at execution. "Tests written" is not the same as "tests pass." "Tests pass" is not the same as "tests verify behavior."

The loop:

1. **Generate** — write the test with full context and explicit framing.
2. **Run** — execute immediately. Catches the most obvious failures (imports, syntax, framework API misuse).
3. **Review** — apply adversarial check to your own freshly-written tests. Load `workflows/review-single.md` and apply it to what you just wrote. (Yes, even your own. Especially your own.)
4. **Revise** — fix what Review surfaces. Revising whole sections often produces better tests than fixing one line at a time.
5. **Repeat** until the test actually catches the bug it claims to catch.

## Before declaring done

Apply `checklists/pre-claim.md` before claiming the work is "tested." Every item on that list must pass.

The single highest-leverage item: **for each test, state in one sentence what bug it would catch.** If you cannot, the test is decorative. Stop and rewrite.

## Cross-references

- Principles and router: `SKILL.md`
- Mock anti-patterns (referenced throughout): `checklists/mock-antipatterns.md`
- Detection patterns: `checklists/fig-leaf-signals.md`
- Pre-claim gate: `checklists/pre-claim.md`
- Contract surfaces: `references/assertion-shape.md`
- Framework specifics: `references/vitest-patterns.md`, `references/bun-test-patterns.md`
- Adversarial review of your own output: `workflows/review-single.md`
