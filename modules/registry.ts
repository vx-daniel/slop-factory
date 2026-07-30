import { baseModule } from './base/module.js'
import { bunTestModule } from './bun-test/module.js'
import { bunModule } from './bun/module.js'
import { configModule } from './config/module.js'
import { gateModule } from './gate/module.js'
import type { ProjectModule } from './module-contract.js'
import { monorepoModule } from './monorepo/module.js'
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
 * `monorepo` keys off `projectStructure` and is orthogonal to both of those sets — a workspace can use
 * any manager and either runner, so it is selected ALONGSIDE one of each rather than instead of them.
 *
 * It was deferred for a long time on the belief that it needed a THIRD channel — post-copy file
 * transforms — because the conversion appears to require rewriting files other modules own: base's
 * tsconfig `paths`, the vitest module's coverage globs, bunfig's discovery scope. It did not, and the
 * reason is worth keeping: `packageSource/` lets a module declare which of its own files are
 * package-relative, so nothing needs moving after the fact, and `templateData()` lets `monorepo` publish
 * a flag that other modules' templates branch on, so nothing needs rewriting after the fact. Each file
 * stays owned by the module that understands it. A transform channel would have been able to corrupt any
 * file in the tree; this arrangement cannot.
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
  monorepoModule,
  configModule,
]
