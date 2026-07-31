# Vitest patterns — what AI commonly gets wrong

Framework-specific supplement to the main skill. Covers the Vitest-specific pitfalls AI tools fall into. Read this when the project's tests use Vitest.

## Identifying Vitest

A project is using Vitest if any of these are true:
- `vitest` listed in `package.json` dependencies or devDependencies
- A `vitest.config.ts` / `vitest.config.js` / `vitest.config.mjs` file exists at the project root
- `package.json` has a `test` script invoking `vitest`
- Existing tests import from `vitest` (`import { test, expect, vi } from 'vitest'`)
- A `vite.config.ts` exists with a `test` block (Vitest reads Vite config)

If you cannot confirm Vitest by one of these checks, do not assume Vitest. Look for bun:test (`bunfig.toml`, imports from `bun:test`) or Jest (`jest.config.js`, imports from `@jest/globals`).

## `vi`, not `jest`

The single most common cross-framework slip. AI training data is heavily Jest-weighted; without explicit anchoring, the agent reaches for `jest.fn` / `jest.mock` / `jest.spyOn`.

Vitest's mock namespace is `vi`:

```ts
import { vi, test, expect } from 'vitest'

const handler = vi.fn()         // not jest.fn()
vi.spyOn(obj, 'method')         // not jest.spyOn(...)
vi.mock('./module')             // not jest.mock(...)
vi.useFakeTimers()              // not jest.useFakeTimers()
```

If existing tests in the project use globals (Vitest's `globals: true` config), `vi` is on the global scope without import. Otherwise import explicitly from `'vitest'`.

## `vi.mock(import('./module'))` — typed module mocks

Vitest supports a typed import-path syntax for `vi.mock` that gives type safety and refactoring support:

```ts
// Preferred — type-safe, refactor-aware
vi.mock(import('./userService.js'), () => ({
  createUser: vi.fn(),
  deleteUser: vi.fn(),
}))

// Legacy — string-path; works but loses type checking
vi.mock('./userService.js', () => ({
  createUser: vi.fn(),
  deleteUser: vi.fn(),
}))
```

Use the `import()` form by default. AI tools often default to the string form because it matches Jest's syntax.

## `restoreMocks: true` in config

Without this, spies and mocks persist across tests. A `vi.spyOn(obj, 'method')` in test A is still active in test B. This is a silent source of test order dependency.

In `vitest.config.ts`:

```ts
export default defineConfig({
  test: {
    restoreMocks: true,
    // also worth considering:
    clearMocks: true,    // clear .mock.calls / .mock.results between tests
    mockReset: true,     // reset implementations to initial state
  },
})
```

If the project does not have `restoreMocks: true` set, either turn it on or `vi.restoreAllMocks()` in `afterEach`. Note this in the AI's self-check before writing mock-heavy tests.

## `vitest run` vs watch mode

Vitest's default is watch mode in interactive shells. AI agents frequently launch `vitest` (no subcommand) and the process never exits, looking like a hang.

Always use `vitest run` for one-shot execution:

```bash
vitest run                      # single pass, exits when done
vitest run path/to/test.ts      # single file
vitest run --reporter=verbose   # detailed output
vitest                          # WATCH MODE — does not exit
```

CI scripts and any non-interactive context must use `vitest run` or `vitest --no-watch`.

## `test.each` for parameterized tests

When testing the same behavior across multiple inputs, `test.each` (or `it.each`) is dramatically clearer than copy-pasted tests.

```ts
test.each([
  { input: 0, expected: 0 },
  { input: 1, expected: 1 },
  { input: 5, expected: 120 },
  { input: 10, expected: 3628800 },
])('factorial($input) === $expected', ({ input, expected }) => {
  expect(factorial(input)).toBe(expected)
})
```

Edge case: `test.each` with template literals supports table syntax:

```ts
test.each`
  input | expected
  ${0}  | ${0}
  ${1}  | ${1}
  ${5}  | ${120}
`('factorial($input) === $expected', ({ input, expected }) => {
  expect(factorial(input)).toBe(expected)
})
```

AI often writes a loop with manual `test()` calls inside. Reach for `test.each` instead.

## `test.extend` for fixtures

Vitest's `test.extend` provides type-safe, per-test scoped fixtures. Preferred over `beforeEach` for setup that varies per test.

```ts
const myTest = test.extend<{
  user: User
  apiClient: APIClient
}>({
  user: async ({}, use) => {
    const u = await createTestUser()
    await use(u)
    await deleteTestUser(u.id)  // teardown after use()
  },
  apiClient: async ({ user }, use) => {
    await use(new APIClient(user.token))
  },
})

myTest('fetches profile', async ({ apiClient, user }) => {
  const profile = await apiClient.getProfile(user.id)
  expect(profile.name).toBe(user.name)
})
```

Benefits over `beforeEach`:
- Fixtures are typed
- Setup and teardown are colocated (the `await use()` pattern)
- Fixtures can depend on other fixtures
- Each test gets its own instance (no shared mutable state)

## `toMatchInlineSnapshot` for small structural assertions

`toMatchInlineSnapshot` writes the snapshot value into the test file itself, so changes are visible in the PR diff. Use for:
- Small structural assertions (parsed AST nodes, error message formats, formatted outputs)
- Cases where the expected value is awkward to write by hand but small enough to inspect

```ts
expect(parseError('foo bar baz')).toMatchInlineSnapshot(`
  {
    "kind": "syntax",
    "position": 4,
    "message": "Unexpected token 'bar'",
  }
`)
```

**Avoid** `toMatchSnapshot` (separate `.snap` file) for arbitrary large outputs — those snapshots get regenerated without anyone reading them. Inline keeps the expectation in front of the reviewer.

## Async patterns

**Promises with `.resolves` / `.rejects`:**

```ts
await expect(fetchUser('123')).resolves.toMatchObject({ id: '123' })
await expect(fetchUser('nope')).rejects.toThrow('Not found')
```

Forgetting the `await` is silent failure — the test passes regardless of the assertion. Always await `.resolves` / `.rejects`.

**Callbacks with `expect.assertions(n)`:**

```ts
test('callback fires with result', () => {
  expect.assertions(1)
  return new Promise<void>((resolve) => {
    fetchUserCallback('123', (err, user) => {
      expect(user?.id).toBe('123')
      resolve()
    })
  })
})
```

`expect.assertions(n)` requires exactly `n` assertions to run during the test. Without it, a callback that never fires would make the test pass silently — the assertion inside never runs.

**Unhandled rejections:**

Vitest fails tests on unhandled promise rejections by default. AI sometimes writes `void promiseFn()` to fire-and-forget, which trips this. Either await the promise or attach a `.catch` handler intentionally.

## `vi.useFakeTimers`

For time-dependent code, control time explicitly. Real `setTimeout` waits in tests are flake sources.

```ts
beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

test('debounce coalesces calls within 100ms', () => {
  const handler = vi.fn()
  const debounced = debounce(handler, 100)
  debounced()
  debounced()
  vi.advanceTimersByTime(50)
  expect(handler).not.toHaveBeenCalled()
  vi.advanceTimersByTime(60)
  expect(handler).toHaveBeenCalledTimes(1)
})
```

`vi.useFakeTimers` also intercepts `Date`, `process.nextTick`, and microtasks (with options). Read the Vitest docs for `vi.useFakeTimers({ toFake: [...] })` when you need finer control.

## Coverage

```bash
vitest run --coverage
```

Vitest uses v8 coverage by default; istanbul is available via config. Coverage report appears in `coverage/` directory.

**Important reminder:** coverage is a floor, not a ceiling. A 100% coverage report with weak assertions is fig-leaf coverage. See the main SKILL.md Section 2 "Coverage gaming detection."

## Common AI-generated mistakes specific to Vitest

| Mistake | Fix |
|---|---|
| `jest.fn()` instead of `vi.fn()` | Replace `jest.` with `vi.` |
| `jest.mock()` instead of `vi.mock()` | Replace; consider `vi.mock(import('./...'))` form |
| Running `vitest` and waiting for it to exit | Use `vitest run` |
| `expect(promise)` without `await .resolves` | Add `await` and `.resolves`/`.rejects` |
| Missing `expect.assertions(n)` in callback tests | Add the count |
| Real `setTimeout` in time-sensitive tests | `vi.useFakeTimers` + `vi.advanceTimersByTime` |
| `toMatchSnapshot` for everything | Inline snapshots for small data; specific assertions for the rest |
| Loop of `test()` calls for parameterized cases | `test.each` |
| `beforeEach` setup that varies per test | `test.extend` fixtures |
| `vi.spyOn` without restore | `restoreMocks: true` in config, or `vi.restoreAllMocks()` in `afterEach` |
