import type { PackageJsonFragment, ProjectModule } from '../module-contract.js'

const NODE_TYPES_VERSION = '^24.10.1'

/**
 * The base module — always selected, and the only module that is not optional.
 *
 * It carries what every generated project needs regardless of runtime, test runner, or features: the
 * tsconfig, the agent rules and skills under `.claude/`, the pre-commit hook, and the four
 * organisation-specific workflow stubs.
 *
 * It deliberately owns NO tooling. Biome belongs to the gate module, the test runner and its coverage
 * pipeline to `vitest` or `bun-test`, and `.ts` execution to `node` or `bun` — so each of those can be
 * swapped without base leaving a dangling script behind. `ci.yml` likewise belongs to the runtime
 * modules, because installing dependencies is package-manager-specific.
 *
 * `@types/node` is the one exception, and it is not really tooling: `tsconfig.json` sets
 * `"types": ["node"]`, so omitting the package fails `tsc --noEmit` with "Cannot find type definition
 * file for 'node'" under either runtime and either test runner.
 */
export const baseModule: ProjectModule = {
  name: 'base',

  documentation: {
    path: 'docs/typescript-setup.md',
    title: 'TypeScript setup',
    summary: 'Path aliases, the mandatory `.js` extension, strictness, and choosing an emit strategy.',
  },

  isSelected(): boolean {
    return true
  },

  packageJsonFragment(): PackageJsonFragment {
    return {
      scripts: {
        // Points git at the committed `.githooks/` directory so the pre-commit gate is active after
        // a plain install, with no separate "run this to wire the hook" step for a new clone to
        // miss. `|| true` keeps installs from failing outside a git work tree — installing inside a
        // tarball or a Docker build context is legitimate and must not hard-error.
        prepare: 'git config core.hooksPath .githooks || true',
      },
      devDependencies: {
        '@types/node': NODE_TYPES_VERSION,
      },
    }
  },
}
