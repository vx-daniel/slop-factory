# The gate

One ordered list of checks, in one file, invoked identically everywhere. `scripts/gate.ts` holds that
list; `check:all` delegates to it; the pre-commit hook and CI both call `check:all`.

The property this buys is that **"green" means one thing**. Nothing has a private notion of passing,
so "it works on my machine" and "CI is green" cannot diverge.

## What runs, and in what order

| Order | Check | Script | What it covers |
|---|---|---|---|
| 1 | `biome` | `lint` | Lint, format, and import organisation — check-only, no writes. |
| 2 | `typecheck` | `typecheck` | `tsc --noEmit` over the package. |
| 3 | `test` | `test` | `vitest run`. |

**Order is cheap-first, deliberately.** A two-second lint failure surfaces before a slow test run, so
the feedback you get is the fastest one available. If you add a check, put expensive behavioural ones
last.

Each gate shells out through `<package manager> run <script>`, so a command's definition lives in
exactly one place: `package.json`. The gate never inlines a tool invocation.

## Adding a check

This is the extension point. Append one entry to `GATES` in `scripts/gate.ts`:

```ts
{
  name: 'build',
  describe: 'bundle for deployment',
  script: 'build',
}
```

Every caller — the pre-commit hook, CI, a developer running `check:all` — inherits it with no other
edit. Candidates worth adding as a project grows: a build, an IaC synth, a container smoke test, a
schema-compatibility check.

## The gate detects its own package manager

Do not hardcode `npm` back into `scripts/gate.ts`. That was a real portability bug: `bun scripts/gate.ts`
ran the TypeScript fine and then died with `Executable not found in $PATH: "npm"` on a machine with
only Bun installed.

Detection uses two signals, in order:

1. **`npm_config_user_agent`** — every major package manager sets it when running a script, and its
   first token is the manager's name (`bun/1.3.14 …`, `npm/11.17.0 …`). Authoritative when the gate
   was reached via `<manager> run check:all`, which is the normal path.
2. **The runtime itself** — when the script is invoked directly (`bun scripts/gate.ts`) no user agent
   is set, but a `Bun` global means we are under Bun.

Falls back to npm. The gate prints which manager it chose, so the decision is visible rather than
inferred.

## A passing gate is necessary, not sufficient

It proves the code compiles and the tests pass. It does **not** prove the behaviour is right. Run the
affected path and look at the output.

This is the rule most often skipped, including by agents. A green `check:all` is a licence to *start*
reviewing behaviour, not a substitute for it.

## Lint rules beyond the defaults

`biome.json` is Biome's `recommended` preset plus stricter overrides. The ones that change how you
write code:

- `noNestedTernary` — error. Nested ternaries are the canonical "clever, unreadable" construct.
- `useNumericSeparators` — error. Group digits: `900_000`, not `900000`.
- `noNonNullAssertion` — error. No `x!`; narrow properly instead.
- `useExplicitLengthCheck` — error. `array.length > 0`, not `array.length`.
- `noTsIgnore` — error. A banned suppression directive fails the gate rather than merely warning.
- `noProcessEnv` — **off** in source (composition roots legitimately read env vars) but **error** in
  `*.test.ts`. A test reaching for `process.env` couples to ambient state that injection exists to
  avoid.
- `useExplicitType` — warn. Explicit return types on exported functions; contextually-typed callbacks
  are exempt, which is why it is a warning rather than an error.

## The naming gate

`.biome/naming.grit` is a GritQL plugin registered via biome.json's `plugins` key, so it runs as part
of `lint`. It catches what Biome's own `useNamingConvention` structurally **cannot**: that rule checks
*case*, not *length* or *meaning*.

| Pattern | Severity |
|---|---|
| Abbreviations in bindings and property keys (`cfg`, `ctx`, `msg`, `req`, `idx`, ~70 more) | **error** |
| Single-character property keys | **error** |
| Single-character bindings | warning (exempt: `_`, `z`; `i`/`j`/`k` are **not** exempt) |
| Generic iteration names (`item`, `value`, `data`, `index`) in `.map`/`.filter`/`for` headers | info |

**The allowlist ships empty, on purpose.** An allowlist is a *specific project's* sanctioned
vocabulary. This project's ancestor arrived carrying a LoRaWAN decoder's list, which would have made
`ts` and `temp` legal in every descendant. Add an entry only with a receipt: the published field name,
the spec term.

## Version pinning

`@biomejs/biome` is pinned **exactly**, not caret-ranged. A Biome minor can add rules, which would
turn a green gate red on an unrelated install — making "the gate passed yesterday" untrue for reasons
nobody changed. Upgrade deliberately, as its own commit, so a new finding is attributable.

`typescript` is tilde-ranged for the same reason at lower intensity: TypeScript treats minors as
breaking for type-checking purposes, so patches only.
