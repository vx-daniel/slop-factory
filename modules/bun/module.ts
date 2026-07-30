import type { PackageJsonFragment, ProjectAnswers, ProjectModule } from '../module-contract.js'

/** Bun 1.3 is the floor: the measurements behind this path (native `.ts` execution, native tsconfig
 * `paths` resolution, Vitest interop) were taken on 1.3.14. */
const BUN_ENGINE_RANGE = '>=1.3'

/**
 * The Bun runtime module — selected when `projectRuntime` is `bun`.
 *
 * Deliberately the thinnest module in the factory, and that thinness is the finding: adopting Bun
 * needs almost nothing ADDED. Bun runs `.ts` natively and resolves tsconfig `paths` natively, so the
 * whole tsx layer simply drops out — there is no Bun equivalent to install in its place.
 *
 * The one real difference that is NOT expressible as a package.json fragment is which lockfile gets
 * committed. That is handled by the rendered `.gitignore` template in the base module, which
 * commits `bun.lock` and ignores `package-lock.json` under this runtime — exactly inverted from the
 * Node path. Committing two lockfiles for one package.json is the failure that guards against: they
 * resolve independently and drift, and nobody notices until a version differs between a teammate's
 * install and CI.
 *
 * `@types/bun` is deliberately NOT added. Nothing in the generated tree needs Bun's globals —
 * `scripts/gate.ts` detects the runtime with a narrow `globalThis` cast specifically to avoid
 * pulling a whole type package in for one truthiness check.
 */
export const bunModule: ProjectModule = {
  name: 'bun',

  documentation: {
    path: 'docs/bun-runtime.md',
    title: 'Running on Bun',
    // Deliberately says nothing about which test runner won: this document ships under BOTH Bun
    // combinations, and the runner is a separate axis with its own document.
    summary: 'What Bun does natively, why tsx drops out, and the lockfile rule.',
  },

  isSelected(answers: ProjectAnswers): boolean {
    return answers.projectRuntime === 'bun'
  },

  packageJsonFragment(): PackageJsonFragment {
    return {
      engines: { bun: BUN_ENGINE_RANGE },
    }
  },
}
