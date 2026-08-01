# bun:test patterns — what AI commonly gets wrong

Framework-specific supplement to the main skill. Covers the bun:test-specific pitfalls AI tools fall into. Read this when the project's tests use bun:test.

Canonical AI guidance for bun:test does not exist in the same form Vitest provides for itself. This document fills that gap. Several of the patterns here come from observed AI failures in production codebases.

## Identifying bun:test

A project is using bun:test if BOTH of these hold:
- `bunfig.toml` exists with a `[test]` section
- `package.json` has a `test` script invoking `bun test`

**Do not identify the runner from the import specifier.** It is tempting to look for
`import { test, expect, mock } from 'bun:test'`, and in many codebases that works — but this
blueprint's bun projects deliberately import from `'vitest'` instead, with a `test/vitest-shim.d.ts`
mapping that specifier onto `bun:test` so one set of test files runs under either runner. A project
whose tests never mention `bun:test` can still be a bun:test project.

The reverse also happens: a project may use Bun purely as the package manager while running Vitest.
That is why the `test` script, not the lockfile and not the imports, is the deciding signal.

bun:test ships with the Bun runtime — there is no separate "install vitest" or "install jest" step —
but shipping with it is not the same as being the configured runner.

## `mock`, not `jest.fn` or `vi.fn`

The most common cross-framework slip. AI training data is dominated by Jest, secondarily by Vitest. Without explicit anchoring, the agent reaches for `jest.fn` or `vi.fn`.

bun:test's mock factory is `mock` from `bun:test`:

```ts
import { mock, test, expect, spyOn } from 'bun:test'

const handler = mock(() => 'result')         // not jest.fn() / vi.fn()
const spy = spyOn(obj, 'method')             // not jest.spyOn / vi.spyOn
mock.module('./module', () => ({ ... }))     // not jest.mock / vi.mock
```

Note: bun:test does not have a `bun` namespace object like Vitest's `vi`. The mock factory is just `mock`, imported directly.

## `mock.module` is process-global and persists across test files

**This is the load-bearing pitfall.** It has caused real production-test failures in repeated cases. Treat this section as required reading before writing any mock-using test in bun:test.

### The behavior

`mock.module(path, factory)` replaces the module at `path` in Bun's module cache. The replacement is **process-global** — every test file that imports from `path` (now, or later in the test run) gets the mock, not the real module.

This is unlike Vitest's `vi.mock`, which is file-scoped by default.

### The failure mode

When test file A uses `mock.module` to partially stub a module, then test file B (running later in the same process) imports something else from that module — file B gets a module whose unstubbed exports are now `undefined`. The errors look like cascading SyntaxErrors or "X is not a function" failures in tests that have nothing to do with the original mock.

```ts
// File A: tests/foo.test.ts
mock.module('@app/services/store', () => ({
  store: { getStorage: () => ({ ... }) }
})) // only stubbed `store`

// File B: tests/bar.test.ts (loaded later in the same `bun test` run)
import { getStore } from '@app/services/store'
// getStore is now `undefined` — File A's mock replaced the entire module
// File B fails with cryptic error, even though it never touched the mock
```

### The rule

When using `mock.module`, mock the **full public surface** of the target module — every named export. Use `keyof typeof import(...)` to enforce coverage at the type level. If a test only exercises one export, still stub the others with benign defaults:

```ts
mock.module('@app/services/store', () => ({
  store: { getStorage: () => ({ ... }) },
  getStore: () => ({ getStorage: () => ({ ... }) }),
  hasStore: () => true,
  setStoreProject: async () => {},
  teardownStore: async () => {},
  StoreNotReadyError: class extends Error {
    constructor() { super('mock') }
  },
}))
```

For modules with many exports, extract the full stub into a reusable fixture (`tests/fixtures/mocks/<module>.ts`) so the complete surface lives in one place. Tests then import the fixture rather than inlining `mock.module` calls.

### Better: prefer dependency injection over module mocking

The cleanest defense is to avoid `mock.module` entirely. Pass dependencies as function arguments (DI / `Deps` pattern). The test supplies real or stubbed implementations directly; there is no process-global mutation:

```ts
// Production code accepts deps
async function processRequest(opts: { db?: Database; logger?: Logger } = {}) {
  const db = opts.db ?? openDatabase()
  const logger = opts.logger ?? createLogger()
  // ...
}

// Test passes mocks via deps — no module mocking needed
test('processes request', async () => {
  const fakeDb = createTestDatabase()
  const result = await processRequest({ db: fakeDb })
  expect(result).toBe(...)
})
```

This pattern is more verbose at the call site but eliminates the process-global pollution risk entirely. When you can DI, do.

### Diagnostic signs of mock.module pollution

When you see these symptoms in a bun:test run, suspect mock.module pollution:
- A test file fails with `X is not a function` for an export that exists in the real module
- "Unhandled error between tests" messages
- Cryptic SyntaxErrors in files that haven't been modified
- A test suite that passes when files are run individually but fails when run all together
- Adding `-t` to isolate the failing test makes it pass

Grep the test suite for `mock.module` calls. Each one is a potential source.

## `spyOn` vs `mock` — when to reach for which

`spyOn` does not pollute globally. It attaches a spy to an existing object's method and is scoped to the test (assuming proper restoration).

```ts
import { spyOn, test, expect } from 'bun:test'

test('logs on error', () => {
  const logger = createLogger()
  const spy = spyOn(logger, 'error')

  doWorkThatErrors(logger)

  expect(spy).toHaveBeenCalledWith(expect.stringContaining('failed'))
  spy.mockRestore() // important — see lifecycle section
})
```

Use `spyOn` when:
- You want to observe calls without changing behavior
- You can pass the object to the code under test (DI again — preferred)
- You want test-scoped mocking without module-cache mutation

Use `mock.module` when:
- The module is imported transitively and you cannot pass it as a dependency
- You have no other option

If you find yourself reaching for `mock.module` frequently, that's a signal the codebase has too much hardcoded import-and-call. Refactoring toward DI eliminates most need for module mocking.

## Lifecycle and restoration

bun:test provides `beforeEach`, `afterEach`, `beforeAll`, `afterAll`:

```ts
import { beforeEach, afterEach, mock } from 'bun:test'

beforeEach(() => {
  // setup per-test state
})

afterEach(() => {
  mock.restore() // restore all mocks set with mock() and spyOn()
})
```

### `mock.restore()` semantics

`mock.restore()` restores all mocks created with `mock()` and spies created with `spyOn()`. It does **not** restore `mock.module` replacements — those are global and persist for the process lifetime.

To "restore" a `mock.module` call, you must call `mock.module(path, () => realImplementation)` with the real module. This is awkward; another reason to prefer DI.

Vitest's `restoreMocks: true` config has no direct bun:test equivalent. Restoration must be explicit in `afterEach`.

## `bun test -t` / `--only`

Focus a run on specific tests:

```bash
bun test                          # run all tests
bun test tests/specific.test.ts   # run a specific file
bun test -t "createUser"          # run tests whose names match the regex
bun test --only                   # only run tests marked .only
```

### `.only` leakage risk

If a test is marked `.only` and committed:

```ts
test.only('focused test', () => { ... })
```

…then bun:test runs only that test. Every other test in the run is silently skipped. CI reports green because the focused test passed.

Check for committed `.only` calls before merging. A pre-commit hook or CI lint step (`grep -rn 'test.only\|describe.only\|it.only' tests/`) catches this.

## Concurrency: bun:test runs tests concurrently by file

Bun's test runner runs different test files in parallel by default. Within a file, tests run sequentially.

Implication: shared module state bites harder than in Vitest's default. A `mock.module` call in file A may finish before file B starts importing — or it may not. The race condition is real.

If you have any module-level singletons, environment variable reads, or file system state, isolate them carefully:
- Reset to known state in `beforeEach`
- Tear down in `afterEach`
- Use per-test temp directories (`Bun.file`-friendly temp paths)
- Don't rely on insertion order in any global map / set / cache

## Time control differs from Vitest's

bun:test has no `vi` namespace, so `vi.useFakeTimers()` has no direct port — but it is not true that
Bun cannot control time. `bun:test` exports **`setSystemTime`** for moving the clock, and a `jest`
compatibility object carrying `jest.useFakeTimers()` / `jest.setSystemTime()`. Reach for those before
reaching for a library.

Remaining gaps and workarounds:

Workarounds:

**1. Inject a clock as a dependency.** The cleanest approach. Production code takes a `now()` function or `Clock` interface; tests supply a controllable fake.

```ts
type Clock = { now: () => number }

const realClock: Clock = { now: () => Date.now() }

function debounce(handler: () => void, ms: number, clock: Clock = realClock) {
  // ... uses clock.now() instead of Date.now() directly
}

// In test
test('debounce', () => {
  let time = 1000
  const fakeClock: Clock = { now: () => time }
  const handler = mock()
  const debounced = debounce(handler, 100, fakeClock)
  debounced()
  time += 150
  debounced()
  // ... etc
})
```

**2. Use a small fake-timer library** (e.g., `@sinonjs/fake-timers` works in Bun). Less clean than DI but doesn't require touching production code.

**3. Avoid time-dependent assertions in unit tests.** Push time-dependent code into a thin layer that gets integration-tested separately.

## Snapshot serializers and inline snapshots

bun:test supports snapshots but the serialization format differs from Vitest's. AI sometimes writes Vitest-shaped snapshot calls that don't quite work in bun:test.

bun:test snapshot APIs:
- `expect(value).toMatchSnapshot()` — external `.snap` file
- `expect(value).toMatchInlineSnapshot()` — inline in the test file (bun:test ≥ 1.1.x)

Custom serializers and snapshot formatters work differently from Vitest. If a test fails with a serialization-related error after AI generation, check whether the snapshot syntax matches bun:test's expectations rather than Vitest's.

Snapshot anti-patterns from `workflows/review-single.md` § "Step 7 — Snapshot anti-patterns" apply: use inline snapshots for small structural assertions; never `toMatchSnapshot` against arbitrary large outputs without diff inspection.

## Async patterns

bun:test supports the same async patterns as other modern test runners:

```ts
test('async assertion', async () => {
  await expect(fetchUser('123')).resolves.toMatchObject({ id: '123' })
  await expect(fetchUser('nope')).rejects.toThrow('Not found')
})
```

`expect.assertions(n)` is supported:

```ts
test('callback fires with result', async () => {
  expect.assertions(1)
  await new Promise<void>((resolve) => {
    fetchUserCallback('123', (err, user) => {
      expect(user?.id).toBe('123')
      resolve()
    })
  })
})
```

Forgetting `await` on `.resolves` / `.rejects` is the same silent-failure trap as in Vitest. Always await async expectations.

## Coverage

```bash
bun test --coverage
```

Bun's coverage differs from Vitest's in two ways that matter for judging a coverage number, both measured against this blueprint's own `bunfig.toml`:

- **There is no branch or statement metric** — Bun reports `% Funcs` and `% Lines` only. Principle 4's "read the branch percentage" is simply unavailable here, so a `??`/`||`/ternary with one side untaken cannot be detected from the coverage table at all.
- **Only files a test imports are measured.** An untested module is absent from the table rather than reported at 0%, so the total can read 100% while whole files go unexercised. A coverage floor cannot catch an orphaned file; only a look at the file list can.

Threshold gating itself does work (`coverageThreshold` in `bunfig.toml`).

Same reminder as in the main SKILL.md: coverage is a floor. 100% line coverage with weak assertions is fig-leaf coverage.

## Common AI-generated mistakes specific to bun:test

| Mistake | Fix |
|---|---|
| `vi.fn()` instead of `mock()` | Import `mock` from `bun:test`; use `mock(() => ...)`. (`jest.fn()` does work — bun:test ships a `jest` compatibility object — but `mock()` is the native spelling.) |
| `jest.mock` or `vi.mock` instead of `mock.module` | Use `mock.module(path, factory)` |
| `jest.spyOn` or `vi.spyOn` instead of `spyOn` | Import `spyOn` from `bun:test` |
| Partial `mock.module` factory (missing exports) | Stub the full public surface; use a fixture file for complex cases |
| Relying on `restoreMocks: true` (Vitest config) | Call `mock.restore()` explicitly in `afterEach` |
| `vi.useFakeTimers` | Inject a clock as a dependency, or use a fake-timer library |
| Snapshot syntax from Vitest | Check bun:test's snapshot format; use inline snapshots for small data |
| `expect(promise)` without `await .resolves` | Add `await` |
| Inline `mock.module` instead of DI | Refactor production code to accept dependencies as parameters |
| Committed `.only` skipping the rest of the suite | Pre-commit hook to grep for `.only`; remove before merge |
| Reliance on test order within a file | Tests must be order-independent; pin state in `beforeEach` / `afterEach` |
| Module-level singletons shared across test files | Reset to known state in `beforeEach`; design code to avoid singletons |

## When in doubt

Two defaults that almost always work:
- **Prefer DI** over module mocking. Pass dependencies as arguments. The test supplies them.
- **Stub the full surface** when `mock.module` is the only path. Use a fixture file. Never partial.

These two disciplines prevent the majority of bun:test mock pollution problems before they happen.
