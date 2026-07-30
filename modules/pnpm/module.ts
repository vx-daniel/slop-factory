import type { PackageJsonFragment, ProjectAnswers, ProjectModule } from '../module-contract.js'

/**
 * The pnpm package manager — selected when `packageManager` is `pnpm`.
 *
 * Like the npm module, it contributes only vocabulary and its own document; the Node runtime bits come
 * from the shared `node` module. Two things differ from npm in ways that matter:
 *
 *   - **`pnpm install --frozen-lockfile`** is the `npm ci` equivalent. Plain `pnpm install` in CI would
 *     silently resolve a different tree when the lockfile is stale.
 *   - **CI needs an extra setup step.** `pnpm/action-setup` must run BEFORE `actions/setup-node`,
 *     because `cache: pnpm` asks setup-node to locate the pnpm store — which requires pnpm to already
 *     be on PATH. Reversing the two is the classic failure here, and it reports as a cache error rather
 *     than a missing binary. That ordering is encoded in `modules/base/ci.yml.hbs`.
 *
 * Worth knowing but not encoded anywhere: pnpm's `node_modules` is a symlinked store with no phantom
 * dependencies, so it surfaces missing transitive and peer dependencies that npm's flat tree hides. A
 * project that installs cleanly under npm can fail under pnpm for that reason — which is a pnpm feature,
 * not a defect. See `docs/pnpm.md` in the generated project.
 */
export const pnpmModule: ProjectModule = {
  name: 'pnpm',

  documentation: {
    path: 'docs/pnpm.md',
    title: 'Using pnpm',
    summary: 'The strict store and phantom dependencies, frozen lockfiles, and the CI step order.',
  },

  isSelected(answers: ProjectAnswers): boolean {
    return answers.packageManager === 'pnpm'
  },

  templateData(): Readonly<Record<string, unknown>> {
    return {
      runCommand: 'pnpm run',
      installCommand: 'pnpm install',
      ciInstallCommand: 'pnpm install --frozen-lockfile',
      nodeCacheKey: 'pnpm',
      /** `pnpm exec`, not `pnpm run` — the target is a binary, not a package.json script. */
      execCommand: 'pnpm exec',
      usesPnpm: true,
      committedLockfile: 'pnpm-lock.yaml',
      ignoredLockfiles: ['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock'],
    }
  },

  packageJsonFragment(): PackageJsonFragment {
    return {}
  },
}
