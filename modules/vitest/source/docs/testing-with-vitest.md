# Testing and coverage

Vitest, with an 85% floor on **all four** metrics and one documented escape valve. The settings live
in `vitest.config.ts`; this explains why they are what they are.

## One floor, four metrics

```
lines: 85   branches: 85   functions: 85   statements: 85
```

A **split** floor (lines 85 / branches 60) is where coverage theatre hides: a suite can post a high
line number while leaving most decision paths unexercised. One number on all four removes that hiding
place.

Raise it as the project matures. The ratchet only turns one way — see
`.claude/rules/broken-windows.md`.

## `coverage.include` measures everything, not just what a test imported

```ts
include: ['src/**/*.ts']
```

This is the single most important line in the coverage config. Without it, a module with **zero tests**
is simply *absent* from the report rather than showing 0% — and the percentage looks healthy while an
entire file goes unexercised. That is the most common way a coverage floor gets silently defeated.

(Vitest ≤2 needed `all: true` for this. The option was removed in Vitest 3+ and is now a type error;
setting `include` is sufficient.)

## `*.io.ts` — the escape valve that keeps the floor honest

A hard 85% floor pushes you toward one of two bad outcomes when you hit genuine boundary glue: lower
the floor, or write fig-leaf tests asserting that a mock was called. Both are worse than the problem.

So: name such a file `*.io.ts` and it is excluded from the metric, **on one condition**:

> It must contain **no branching and no computation.**

Every decision belongs in a pure module that *is* covered. If you find yourself wanting an `if` inside
an `.io.ts`, that condition belongs in a tested function.

What legitimately lives in an `.io.ts`: the process bootstrap, an HTTP handler that only wires
request → pure function → response, a database write, a console or filesystem write.

**This is a convention, not a loophole.** Do not rename a file to `.io.ts` to dodge the floor. Verify
these files by running the real thing, not by mocking — see `.claude/skills/test-quality/` on why "it
was mocked" is not evidence.

Also excluded, each for a reason that survives scrutiny:

| Pattern | Why |
|---|---|
| `src/**/*.test.ts` | The tests themselves. |
| `src/**/types.ts` | Type-only modules erase at runtime; there is nothing to execute. |
| `src/**/*.d.ts` | Declarations, same reason. |

An exclude is the easiest way to fake a coverage number, so the bar for adding one is "this file cannot
meaningfully be unit-tested", never "this file is inconvenient to test".

## `passWithNoTests` is on, and the floor is what keeps it safe

A freshly generated project has no source code and therefore no tests. Vitest's default is to treat
"no test files found" as exit code 1, which would make the gate **red on day one**, before a line has
been written. Zero tests is the correct state for an empty project, so it must not read as a failure.

This does not lose the signal that setting normally provides — a glob that stopped matching. The
coverage floor is the backstop: if the include globs break once tests exist, the suite stops running,
coverage drops to 0%, and `coverage` fails the threshold. CI runs **both** `check:all` and `coverage`
(see `.github/workflows/ci.yml`), so a silently-empty suite still fails the build — one gate later than
it otherwise would, but it does fail.

## Reporters, and which are load-bearing

```ts
reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov']
```

- **`json-summary` is required, not cosmetic.** `scripts/coverage-to-markdown.ts` reads
  `coverage/coverage-summary.json` to build `COVERAGE.md`. Dropping it breaks `coverage` and the
  `coverage-main.yml` workflow.
- `text` is the per-file table during a run; `text-summary` the compact totals line at the end.
- `html` backs `coverage:open`.
- `lcov` feeds editor gutter extensions — VS Code's Coverage Gutters and similar read
  `coverage/lcov.info`. This turns coverage from a report you remember to open into an annotation on
  the line you are editing.

`reportsDirectory: './coverage'` is stated explicitly rather than left to the default because it is a
**contract**: `scripts/coverage-to-markdown.ts` and `.github/workflows/coverage-main.yml` both
hardcode `coverage/`. Moving it silently breaks both.

## Test layout — pick one

```ts
include: ['src/**/*.test.ts', 'test/**/*.test.ts']
```

Colocated and separate layouts both work out of the box. **Pick one and delete the other glob** rather
than leaving two conventions live; two live conventions means every new file is a small decision.

## Path aliases in tests

`resolve: { tsconfigPaths: true }` resolves `@/*` from `tsconfig.json` rather than restating the
mapping. This is Vite's **native** support — the `vite-tsconfig-paths` plugin does the same job, is
what most search results still recommend, and is redundant here (Vitest logs a notice telling you to
remove it).

Without this line an aliased import **typechecks and then fails at test time**, which is a
particularly annoying failure mode because the type-checker told you it was fine.

## Writing tests that actually catch bugs

`.claude/skills/test-quality/` is the procedure, including the mutation-review discipline: break the
implementation, confirm a test goes red, revert. A test that stays green when you break the code it
covers is not a test — it is a fig leaf, and it is worse than no test because it reports safety that
does not exist.
