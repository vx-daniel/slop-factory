import { baseModule } from './base/module.js'
import { bunTestModule } from './bun-test/module.js'
import { bunModule } from './bun/module.js'
import { configModule } from './config/module.js'
import { gateModule } from './gate/module.js'
import type { ProjectModule } from './module-contract.js'
import { nodeModule } from './node/module.js'
import { npmModule } from './npm/module.js'
import { pnpmModule } from './pnpm/module.js'
import { vitestModule } from './vitest/module.js'

/**
 * Every module the factory knows about, in the order they are applied.
 *
 * ORDER IS MEANINGFUL in one narrow way: it is the order package.json fragments merge, which decides
 * which module a conflict message names as the prior owner. It does NOT decide precedence — a genuine
 * conflict throws rather than letting a later module win (see `mergePackageJsonFragments`), so
 * reordering this list cannot silently change a generated project. Registered roughly outside-in:
 * the always-on modules, then the runtime choice, then the test-runner choice, then opt-in features.
 *
 * TWO SETS ARE MUTUALLY EXCLUSIVE — a TRIPLE and a PAIR — and the registry does not enforce that; the
 * `isSelected` predicates do, keyed off a single answer each. `npm`/`pnpm`/`bun` key off
 * `packageManager`, and `vitest`/`bun-test` off `testRunner`. `registry.test.ts` asserts exactly one
 * manager and exactly one runner is ever selected, because two selected managers would contribute
 * conflicting `engines` and two selected test runners would conflict on the `test` script.
 *
 * `node` IS THE EXCEPTION, and it is worth being explicit because it reads like a fourth manager: it is
 * selected ALONGSIDE npm or pnpm rather than instead of them, keyed off the runtime those managers imply.
 * It carries the two things both need and nothing else — the Node engine floor and tsx. A third Node
 * manager would join the same arrangement without touching it.
 *
 * NOT REGISTERED: `monorepo`. The directory exists but the module is deliberately unbuilt, because
 * the workspace conversion is not expressible in this contract's two channels — it must REWRITE
 * files OTHER modules own (base's tsconfig `paths`, the vitest module's coverage globs) rather than add
 * files of its own.
 * It also needs three decisions made before it can be written, and each forecloses the others:
 *   1. Cross-package imports by package name (`@acme/core/...`) or explicit per-package aliases.
 *   2. tsconfig project references (needs `composite` + `declaration`, conflicting with the blanket
 *      `noEmit` this ships) or one tsconfig pointing at every package's `src`.
 *   3. One of three Vitest discovery mechanisms, which do not compose.
 * Offering a `monorepo` option that generates a subtly broken project is worse than not offering it,
 * so the prompt does not ask. Adding it later means a third channel — post-copy file transforms.
 */
export const PROJECT_MODULES: readonly ProjectModule[] = [
  baseModule,
  gateModule,
  nodeModule,
  npmModule,
  pnpmModule,
  bunModule,
  vitestModule,
  bunTestModule,
  configModule,
]
