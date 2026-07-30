# TypeScript setup

`tsconfig.json` is typecheck-only and strict, with one path alias. Three things about it are
non-obvious and load-bearing.

## Path aliases — one source of truth

`@/*` maps to `src/*`, so a deep import reads:

```ts
import { buildOrderSummary } from '@/orders/summary.js'   // not '../../../orders/summary.js'
```

which also survives the *importing* file being moved.

`tsconfig.json`'s `paths` is the **single source of truth**. Consumers read it rather than restating
it, so adding an alias in one place propagates:

| Consumer | How it reads tsconfig `paths` |
|---|---|
| `tsc` | Directly. |
| Vitest | `resolve.tsconfigPaths: true` in `vitest.config.ts` — Vite's native support. |
| Runtime | `tsx` under Node, natively under Bun. **Node's own resolver does not read tsconfig.** |

**A dropped consumer fails in a confusing way.** Turn off `resolve.tsconfigPaths` and aliased imports
still typecheck, then fail only at test time — the type-checker having assured you it was fine. If you
add a fourth consumer (a bundler, an ESLint resolver), point it at tsconfig rather than copying the
mapping.

**There is no `baseUrl`, deliberately.** It is deprecated and stops functioning in TypeScript 7, which
this project pins. Since TS 5 `paths` works without it, with entries resolved relative to the
tsconfig's own directory — which is why they read `./src/*`.

## The `.js` extension is mandatory

ESM plus `moduleResolution: NodeNext` means every relative and aliased import must carry a `.js`
extension. It resolves to the `.ts` source:

```ts
import { formatTotal } from './format.js'          // not './format'
import { getConfig } from '@/config/config.js'     // not '@/config/config'
```

Omitting it is a hard error, not a warning. This is the single most common surprise for anyone arriving
from a bundler-based setup, where extensionless imports work.

## Strictness, and what is deliberately delegated

`strict: true` turns the whole family on. The individual flags are listed in the file for
discoverability, **not** to carve out exceptions — nothing may weaken `strict`.

Two flags are deliberately **off**, and it is not an oversight:

```jsonc
"noUnusedLocals": false,
"noUnusedParameters": false,
```

Unused locals and parameters are Biome's job (`correctness/noUnusedVariables`,
`correctness/noUnusedImports`), and Biome reports them **with autofixes**. Enabling them here too would
double-report one finding across the gate's `biome` step and its `typecheck` step — the same problem
surfacing twice, in two different formats, one of which cannot fix it for you.

`isolatedModules: true` is required by the ESM + NodeNext setup: each file must be transpilable in
isolation, because that is all the test runner's esbuild and Node's type-stripping ever see.

## Root config files are listed explicitly

```jsonc
"include": ["src", "test", "scripts", "vitest.config.ts"]
```

Without naming the root config files, `tsc --noEmit` **silently skips the very files that configure the
gate** — a type error in `vitest.config.ts` would surface as a runtime failure instead of a typecheck
failure. Add any future root-level config file here too.

## Choosing an emit strategy

`noEmit: true` and there is no `build` script. This is a real decision deferred to you, not an
omission — the three common answers need incompatible settings, so shipping one would mean two of three
projects start by undoing it:

**Run TypeScript directly, no build** (scripts, CLIs, servers). Change nothing; this is what the project
already does.

**Ship a library.** Set `"noEmit": false`, `"declaration": true`, `"outDir": "dist"`; add
`"build": "tsc"` and the `main` / `types` / `exports` fields to package.json.

**Bundle for a runtime** (browser, Lambda, edge worker, container). Keep `noEmit` — the bundler owns the
output — and add a `build` script plus a bundler config. Consider appending a `build` entry to `GATES`
in `scripts/gate.ts` so a bundle that fails to build fails the gate.

Whichever you pick, add the output directory to `.gitignore` (`dist/` is pre-declared).

## Agent rules and skills

`.claude/rules/` holds the conventions — naming, TypeScript patterns, Zod usage, options objects,
discipline, broken windows, memory. Each file states whether it is **mechanically gated** or
**review-enforced**, so a green gate is never mistaken for "the conventions are met".

`.claude/skills/` holds procedures rather than conventions: `test-quality` for writing and reviewing
tests, and the two-index memory system.

**These rules arrived from another project and their examples are generic** (orders, sessions). A rule
citing a module that does not exist actively misleads, because agents follow it. Re-fit the examples to
real code once you have some — `.claude/rules/broken-windows.md` § "Don't Broaden Scope While Cleaning"
documents this as a repeated, measured cost.
