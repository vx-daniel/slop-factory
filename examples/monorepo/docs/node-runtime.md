# Running on Node

This project targets **Node 24+** and runs its TypeScript **without a build step**, through
[tsx](https://github.com/privatenumber/tsx) — `node --import tsx <file>`.

This document is about the **runtime**, which is a separate question from the package manager. Node is
the runtime for both npm and pnpm, so this file ships for either — and everything below applies
unchanged to both. For the manager-specific half (install commands, which lockfile is committed, CI
setup steps) see `npm.md` or `pnpm.md` in this folder, whichever is present.

## Why tsx and not bare `node`

Node 24 runs `.ts` files natively, but it **strips** types rather than compiling them. Any TypeScript
construct that needs code *generated* for it is rejected at parse time with a hard `SyntaxError`, not a
graceful degradation.

Measured on Node v24.12.0:

| | `node file.ts` | `node --experimental-transform-types` | `tsx` |
|---|---|---|---|
| Types, interfaces, generics | ✅ | ✅ | ✅ |
| `enum` / `const enum` | ❌ | ✅ | ✅ |
| `namespace` | ❌ | ✅ | ✅ |
| Parameter properties (`constructor(private x)`) | ❌ | ✅ | ✅ |
| **Decorators** | ❌ | ❌ | ✅ |
| **tsconfig `paths` aliases** | ❌ | ❌ | ✅ |

The last two rows are the ones **no Node flag covers**, and they are exactly what a decorator-driven
framework (NestJS, TypeORM, class-validator) or an aliased `@/*` import layout requires.

**This project ships `@/*` aliases, so bare `node` throws `ERR_MODULE_NOT_FOUND` on the first aliased
import.** tsx is load-bearing, not ceremony. Do not "simplify" the npm scripts to plain `node`.

tsx also brings a watch mode: `tsx watch <file>`.

## When you could drop tsx

If you strip the path aliases out and never use decorators, revert the scripts to plain
`node scripts/*.ts`. Nothing else depends on tsx.

Weigh that against what the aliases buy: `@/orders/store.js` instead of `../../../orders/store.js`,
and an import that survives the importing file being moved.

## The `.js` extension is mandatory

ESM + `moduleResolution: NodeNext` means every relative and aliased import must carry a `.js`
extension, which resolves to the `.ts` source:

```ts
import { buildOrderSummary } from '@/orders/summary.js'   // not '@/orders/summary'
import { formatTotal } from './format.js'                 // not './format'
```

Omitting it is a hard error, not a warning. This surprises people coming from bundler-based setups
where extensionless imports work.

## Node version floor

`engines` requires `>=24`, and CI pins 24. The floor is 24 because the project runs `.ts` without a
build step and native type-stripping only stabilised in 23.6 — 24 is the first LTS line that has it.

Even though tsx does the actual loading, the floor stays at 24: dropping it would imply the project
runs on older Node, and the moment anyone runs a script with bare `node` on Node 20 they get a parse
error instead of a clear engine mismatch.

## Switching to Bun later

Most of this project runs under Bun unchanged — Bun executes `.ts` natively and resolves tsconfig
`paths` natively, so the whole tsx layer drops out.

Switching the runtime does **not** oblige you to switch test runners. Keeping Vitest under Bun is the
lower-risk move: `bun test` offers no `json-summary` coverage reporter and no branch coverage, so
adopting it would cost the committed `COVERAGE.md` and reduce the floor from four metrics to two. See
`testing-with-vitest.md` in this folder for what the coverage setup depends on.

The essentials if you do switch:

1. Drop `tsx` from devDependencies and rewrite the scripts that use it (`check:all`, `coverage`,
   `coverage:readme`) to invoke `bun` directly.
2. Change `engines` from `node` to `bun`.
3. Invert the lockfile rules in `.gitignore` — commit `bun.lock`, and ignore whichever lockfile this
   project commits today (see `npm.md` or `pnpm.md`). Never commit two lockfiles for one
   `package.json`; they resolve independently and drift, and nobody notices until a version differs
   between a teammate's install and CI.
4. Rewrite the install and setup steps in `.github/workflows/ci.yml` — `oven-sh/setup-bun` replaces
   `actions/setup-node` (and `pnpm/action-setup`, if present), and the install command becomes
   `bun install --frozen-lockfile`.
5. `rm -rf node_modules && bun install && bun run check:all`.

`scripts/gate.ts` needs no change — it detects its own package manager.
