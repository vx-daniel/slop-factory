import type { PackageJsonFragment, ProjectAnswers, ProjectModule } from '../module-contract.js'

/**
 * The npm package manager — selected when `packageManager` is `npm`. The default.
 *
 * Contributes no dependencies and no files beyond its own document: it exists to supply the
 * package-manager VOCABULARY that the generated documentation and CI workflow interpolate. The Node
 * runtime bits it needs — the engine floor and tsx — come from the `node` module, which is shared with
 * pnpm rather than duplicated here.
 *
 * `ciInstallCommand` is `npm ci` rather than `npm install`, deliberately: `ci` fails when the lockfile
 * and package.json disagree instead of silently resolving a different tree, so CI cannot pass against
 * versions no developer has installed.
 */
export const npmModule: ProjectModule = {
  name: 'npm',

  documentation: {
    path: 'docs/npm.md',
    title: 'Using npm',
    summary: 'Why `npm ci` in CI, which lockfile is committed, and what to know before switching.',
  },

  isSelected(answers: ProjectAnswers): boolean {
    return answers.packageManager === 'npm'
  },

  templateData(): Readonly<Record<string, unknown>> {
    return {
      runCommand: 'npm run',
      installCommand: 'npm install',
      ciInstallCommand: 'npm ci',
      /** Value for `actions/setup-node`'s `cache:` input. */
      nodeCacheKey: 'npm',
      /** How CI invokes a binary from node_modules, e.g. `npx vitest run --coverage`. */
      execCommand: 'npx',
      /** Drives the extra `pnpm/action-setup` step in the CI template. */
      usesPnpm: false,
      committedLockfile: 'package-lock.json',
      /** Every OTHER manager's lockfile, so `.gitignore` commits exactly one. */
      ignoredLockfiles: ['pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'yarn.lock'],
    }
  },

  packageJsonFragment(): PackageJsonFragment {
    return {}
  },
}
