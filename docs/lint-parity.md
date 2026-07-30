# Lint parity: oxlint (the factory) vs Biome (generated projects)

The factory lints itself with **oxlint**. The projects it generates lint themselves with **Biome** plus a
GritQL naming plugin (`modules/gate/source/biome.json`, `modules/gate/source/.biome/naming.grit`).

**These are different tools, and the factory is therefore held to a slightly different standard than its
own output.** That divergence is deliberate but it is not free — this document is the accounting, so
nobody mistakes a green `npm run lint` for "this would pass the Biome gate we ship."

Mapping verified against oxlint **1.76.0**, whose bundled `configuration_schema.json` enumerates 847
rules. Every claim below was checked against that list rather than assumed.

## Why two tools at all

The honest answer: this was a deliberate experiment, not a conclusion. oxlint is dramatically faster and
needs no separate plugin to reach most of the rules Biome's config picks. Whether the factory should
instead eat its own dog food and run Biome is an open question — if the gaps below start mattering, that
is the argument for switching.

What the divergence buys, concretely: the factory's `lint` step runs in milliseconds and requires no
`.biome/` plugin compilation. What it costs is the five gaps in the last section.

## Rules that map cleanly

| Biome rule | oxlint rule | Notes |
|---|---|---|
| `complexity/noUselessTernary` | `no-unneeded-ternary` | |
| `complexity/noUselessTypeConstraint` | `typescript/no-unnecessary-type-constraint` | |
| `complexity/noExcessiveNestedTestSuites` | `vitest/max-nested-describe` | |
| `complexity/noImplicitCoercions` | `no-implicit-coercion` | |
| `complexity/noUselessStringConcat` | `no-useless-concat` | |
| `complexity/useMaxParams` | `max-params` (`max: 3`) | **Stricter here than in generated projects.** Biome's rule defaults to 4; 3 is the project's actual convention ("options object at 3+"), which Biome cannot express and so leaves to review. Where a tool can gate a real convention, it should. |
| `correctness/noUnusedImports` | `no-unused-vars` | oxlint folds unused imports into the general rule rather than splitting them out. |
| `suspicious/noConsole` | `no-console` | `warn` in both. |
| `suspicious/noTsIgnore` | `typescript/ban-ts-comment` | |
| `suspicious/noExplicitAny` | `typescript/no-explicit-any` | |
| `suspicious/noEmptyBlockStatements` | `no-empty` | |
| `style/noNestedTernary` | `no-nested-ternary` | |
| `style/useNumericSeparators` | `unicorn/numeric-separators-style` | |
| `style/useThrowOnlyError` | `typescript/only-throw-error` | |
| `style/useThrowNewError` | `unicorn/throw-new-error` | |
| `style/noNonNullAssertion` | `typescript/no-non-null-assertion` | |
| `style/useExplicitLengthCheck` | `unicorn/explicit-length-check` | |
| `style/noProcessEnv` | `node/no-process-env` | Same inversion in both: off in source, error in `*.test.ts`. |
| `nursery/useExplicitType` | `typescript/explicit-function-return-type` | `warn` in both. |
| `nursery/noConditionalExpect` | `vitest/no-conditional-expect` | |
| `nursery/noUselessTypeConversion` | `typescript/no-unnecessary-type-conversion` | |

## Rules that map approximately

**`noExcessiveCognitiveComplexity` → `complexity`.** Not the same metric. Biome measures **cognitive**
complexity, which weights nesting depth; oxlint (following ESLint) measures **cyclomatic** complexity,
a raw branch count. A deeply-nested function with few branches fails Biome and passes oxlint; a flat
function with a long `switch` does the reverse. Threshold set to 15, matching Biome's default number —
but the number means something different, so a function near the limit is not portable between them.

**`useSimplifiedLogicExpression` → nothing exact.** oxlint has
`unicorn/prefer-logical-operator-over-ternary` and `logical-assignment-operators`, which overlap
partially. Neither is enabled, because a partial stand-in would imply coverage that does not exist.

## Rules with no oxlint equivalent — the gaps

These are the reasons a green factory lint is **not** equivalent to a green Biome gate.

### 1. The GritQL naming plugin has no counterpart

`modules/gate/source/.biome/naming.grit` flags abbreviations (`cfg`, `ctx`, `msg`, `idx`, ~70 more) and
single-character bindings — the thing Biome's own `useNamingConvention` structurally cannot catch,
because it checks case rather than length or meaning.

oxlint has **no GritQL support**, and — checked, because it is the obvious hope — the plugin's upstream
inspiration `unicorn/prevent-abbreviations` is **absent from all 138 unicorn rules oxlint ships**. So the
single most distinctive convention in this project's standard is entirely unenforced on the factory's own
code. It remains review-enforced here, and mechanically gated only in generated projects.

This is the largest gap by some distance.

### 2. `performance/noReExportAll`

No oxlint rule exists. Biome caught a real instance of this during development — `export * from 'bun:test'`
in the bun-test module's type shim, which had to become an explicit named re-export list. That finding
would not surface here.

### 3. `nursery/noFloatingPromises`

`typescript/no-floating-promises` exists in oxlint's rule list but requires type information, which
oxlint does not have in the mode this config uses. Unhandled promise rejections in factory code are
caught only by review and by tests failing.

### 4. `nursery/useExhaustiveSwitchCases`

`typescript/switch-exhaustiveness-check`, same reason as above.

### 5. Formatting and import sorting

Biome's config enables a **formatter** (2-space indent, 120 columns, single quotes, semicolons as needed,
LF) and two assist actions (`organizeImports`, `noDuplicateClasses`). **oxlint is a linter only** — it has
no formatter and does not sort imports.

Consequence: the factory's source has no mechanically-enforced format, while every project it generates
does. Import order in factory files is by hand and will drift. Adding a formatter — `oxfmt`, or Biome in
format-only mode — is the obvious follow-up, and would be the cheapest way to close a gap that touches
every file.

### Not applicable

`useSortedClasses`, `noDuplicateClasses`, and `noUnknownAtRules` are Tailwind and CSS rules. The factory
ships no CSS.

## Two rules configured that Biome does not have

**`vitest/valid-expect` with `maxArgs: 2`.** Kept because its "async assertions must be awaited" half
caught two real defects in this repo's own tests — `expect(promise).resolves.…` with no `await`.

`maxArgs: 2` is required, not a relaxation. oxlint's default is 1 because the rule is modelled on Jest,
whose `expect` takes one argument. Vitest's does not: `@vitest/expect/dist/index.d.ts:184` declares
`<T>(actual: T, message?: string)`, and the message is prepended to the failure output — verified,
`expect(false, 'MARKER').toBe(true)` reports `AssertionError: MARKER: expected false to be true`. Leaving
the default would have forced a choice between deleting every custom failure message in the suite (the
generation tests carry command output in theirs) and disabling the rule outright, losing the await check
with it.

**`vitest/expect-expect` with `assertFunctionNames`.** Enabled by the `correctness` category rather than
chosen, and listed explicitly only to declare this repo's assertion HELPERS. The rule flags a test whose
body contains no `expect`, which is a correct default. But `tests/generation.test.ts` runs the same
assertion pair against eight package-manager combinations, so the pair lives in a named helper
(`expectOnlyThisManagersInstall`) — and the rule then reads every calling test as assertion-free.

Naming the helper is a **declaration, not a relaxation**: it tells the rule where the assertions moved
to. The alternative was inlining the pair into each caller, which is the duplication the helper removes.
A helper added later must be named there too, otherwise its callers fail the rule — the intended
behaviour, not a bug.

Biome has no equivalent, so this is a place where the factory's own gate is *stricter* than the Biome
gate it prescribes for generated projects.

## What is not linted, and why

`ignorePatterns` in `.oxlintrc.json` excludes:

- **`modules/*/source/`** — templates destined for a generated project. They compile against *that*
  project's tsconfig, use `@/*` aliases that only resolve there, and target TypeScript 7 while the factory
  runs 5.9. Findings here would not be findings anywhere real. Same reasoning as `tsconfig.json`'s
  `exclude` and the Vitest `unit` project's.
- **`examples/`** — generated artifacts, byte-for-byte guaranteed by `examples:check`. The only way to fix
  a finding is to change the module that produced it.
- `node_modules`, `dist`, `coverage`.

Note the consequence: **the generated projects' own source is linted by Biome in those projects, never by
oxlint here.** The two standards never meet on the same file, which is what makes the gaps above tolerable
— they affect factory code only.

## Category selection

Biome uses `preset: recommended` plus individually chosen rules. The closest oxlint analogue is
`categories: { correctness: "error" }` plus the explicit list above.

`pedantic`, `style`, and `restriction` are deliberately **not** enabled wholesale. Turning on a whole tier
would introduce dozens of rules nobody chose and make the two configs diverge in unexamined ways. Ratchet
them on individually, and record each addition here.

## Keeping this document honest

If you change `.oxlintrc.json` or `modules/gate/source/biome.json`, update this file in the same change.
A parity document that no longer describes the configs is worse than none — it is a confident, wrong
answer about what is enforced. There is no automated check for this; it is on review.
