# Checklist: Mock anti-patterns

Five named patterns AI most often falls into when writing tests with mocks. Each has a violation example, the reason it's wrong, the fix, and a detection rule.

Referenced from `workflows/generate.md` (write-time prevention) and `workflows/review-single.md` (review-time detection). Single source of truth for the mock-specific content.

## 1. Testing mock behavior

**Violation:**
```ts
test('renders sidebar', () => {
  render(<Page />)
  expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument()
})
```

**Why wrong:** Verifies the mock works, not the component. The test passes whenever the mock is present, regardless of whether `Page` would actually render the real sidebar. Provides zero confidence about production behavior.

**Fix:** Test the real component, or assert on real behavior:
```ts
test('renders sidebar', () => {
  render(<Page />)  // real Sidebar
  expect(screen.getByRole('navigation')).toBeInTheDocument()
})
```

**Detection rule:** If an assertion contains `*-mock` or checks `mock.toHaveBeenCalled()` without follow-up verification of what production code did with that call, stop. Either delete the assertion or unmock the dependency.

## 2. Test-only methods in production code

**Violation:**
```ts
class Session {
  async destroy() {  // only called from afterEach
    await this.workspaceManager?.destroy()
  }
}
```

**Why wrong:** Pollutes production API with test-specific code. Risk of accidental production calls. Violates YAGNI. Confuses class responsibilities.

**Fix:** Test utility owns cleanup. Production class has no test-only methods.
```ts
// test-utils.ts
export async function cleanupSession(session: Session) {
  const ws = session.getWorkspaceInfo()
  if (ws) await workspaceManager.destroy(ws.id)
}
```

**Detection rule:** Before adding a method to a production class, search the codebase. Is it only called from test files? Does this class own this resource's lifecycle in production? If only-tests OR not-lifecycle-owner, the method goes in a test utility.

## 3. Mocking without understanding dependencies

**Violation:**
```ts
test('detects duplicate server', () => {
  mock('ToolCatalog', () => ({ discoverAndCacheTools: mockFn() }))
  await addServer(config)
  await addServer(config)  // should throw but won't — config never written!
})
```

**Why wrong:** The mocked method writes the config that duplicate detection reads. Over-mocking "to be safe" breaks test logic. The test passes (or fails) for the wrong reasons.

**Fix:** Mock only external/slow operations. Preserve test dependencies.
```ts
test('detects duplicate server', () => {
  mock('MCPServerManager')  // mock the slow process startup only
  await addServer(config)   // config written ✓
  await addServer(config)   // duplicate detected ✓
})
```

**Detection rule:** Before mocking, list the method's side effects. Identify what the test needs. Mock only what's external/slow. If you cannot explain why each mock is needed, stop.

## 4. Incomplete mock data structures

**Violation:**
```ts
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' }
  // metadata field missing — production code accesses response.metadata.requestId
}
```

**Why wrong:** Partial mocks hide structural assumptions. Tests pass; production fails when downstream code reads omitted fields. False confidence in coverage.

**Fix:** Complete structure matching the real API.
```ts
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' },
  metadata: { requestId: 'req-789', timestamp: 1234567890 }
}
```

**Detection rule:** Before creating mock data, check API docs or a real response example. Include all documented fields. Use realistic values. If uncertain, include all documented fields and link to the schema source in a comment.

## 5. Tests as afterthought

**Violation:**
```
Implementation complete → no tests yet → "ready for review"
```

**Why wrong:** Testing is part of implementation, not optional. Cannot claim completion without tests. Violates TDD; the implementation got built without test pressure, which is exactly when fig-leaf patterns sneak in.

**Fix:** TDD cycle: failing test first, watch it fail, implement, refactor, then claim done.

**Detection rule:** If implementation is done and tests have not been written or run, work is not complete regardless of how it looks.

## When mocks signal deeper issues

Some mock patterns indicate the test suite is solving the wrong problem. Warning signs:

- Mock setup is more than 50% of the test code
- Mocking everything just to make the test pass
- Mocks are missing methods that real components have
- Test breaks when the mock implementation changes
- Can't explain why each mock is necessary

The question to ask: **"should this be an integration test with real components?"**

Complex mocks often indicate an integration test would be simpler, more valuable, and more honest. The mock complexity is paying for what real integration would give for free.

## Quick-reference table

| Anti-pattern | Detection signal | Fix |
|---|---|---|
| Testing mock behavior | Assertions on `*-mock` elements or `mock.toHaveBeenCalled` alone | Test real component or remove the mock |
| Test-only methods | Method only appears in test file searches | Move to test utility |
| Blind mocking | Cannot explain mock purpose | List side effects, mock minimally |
| Incomplete mocks | Missing fields the production code reads | Include all documented fields |
| Tests as afterthought | Implementation complete before tests written | TDD: failing test first |
| Over-complex mocks | Setup > 50% of test | Use integration test |

## Cross-references

- Generation-time prevention: `workflows/generate.md`
- Review-time detection: `workflows/review-single.md`
- Broader detection patterns: `checklists/fig-leaf-signals.md`
- Framework-specific mock pitfalls (vi.fn vs jest.fn vs mock): `references/vitest-patterns.md`, `references/bun-test-patterns.md`
