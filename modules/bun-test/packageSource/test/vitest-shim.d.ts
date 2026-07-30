/**
 * Makes the `vitest` module specifier typecheck under `bun test`.
 *
 * THE PROBLEM. Bun maps `import { describe, it, expect } from 'vitest'` onto its own test API at
 * runtime, which is why test files written against the Vitest API run unmodified under `bun test` with
 * Vitest not installed. But `tsc` cannot follow that mapping — it looks for a real `vitest` package,
 * does not find one, and fails every test file with:
 *
 *     error TS2307: Cannot find module 'vitest' or its corresponding type declarations.
 *
 * So the tests pass and the typecheck gate fails, which is the worst possible split: the code is
 * correct and the gate says otherwise.
 *
 * THE FIX. Declare the module, forwarding each name to `bun:test`, whose types come from `@types/bun`.
 * One ambient declaration covers the whole program, so tests anywhere under `src/` or `test/` are
 * handled — including the layered-config module's tests, which are written against the Vitest API.
 *
 * WHY NOT REWRITE THE IMPORTS TO `bun:test`? Because that would forfeit the main practical advantage of
 * this setup: switching to Vitest later stays a config change rather than a codemod across every test
 * file. This shim is a dozen lines; a one-way door is not worth saving them.
 *
 * WHY NAMED EXPORTS RATHER THAN `export *`? Two reasons. Biome's `noReExportAll` forbids the star form,
 * and more usefully, the explicit list IS the compatibility surface: a name absent here is a name
 * `bun test` does not provide, and you find that out at typecheck instead of at runtime. Notably absent
 * is Vitest's `vi` — Bun has no equivalent, so use `mock` and `spyOn` below rather than expecting a
 * shim to invent one.
 *
 * DELETE THIS when migrating to Vitest — at that point the real package supplies the types, and leaving
 * the shim would shadow them.
 */
declare module 'vitest' {
  export {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
    setSystemTime,
    spyOn,
    test,
  } from 'bun:test'
}
