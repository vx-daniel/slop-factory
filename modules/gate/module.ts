import {
  type PackageJsonFragment,
  type ProjectAnswers,
  type ProjectModule,
  typescriptRunnerPrefix,
} from '../module-contract.js'

/** Pinned exactly, not caret-ranged: a Biome minor can add rules, which would turn a green gate red
 * on an unrelated install and make "the gate passed yesterday" untrue for reasons nobody changed. */
const BIOME_VERSION = '2.5.6'

/** Tilde-ranged: TypeScript treats minors as breaking for type-checking purposes, so patch-only. */
const TYPESCRIPT_VERSION = '~7.0.2'

/**
 * The gate module — always selected.
 *
 * Owns the single definition of "green": Biome, the naming plugin, `tsc --noEmit`, and the ordered
 * gate runner that both the pre-commit hook and CI invoke. It owns `typescript` (not the runtime
 * modules) because the type-checker is a CHECK, and every check belongs to whoever defines the gate;
 * splitting the compiler away from the `typecheck` script that runs it would let one be selected
 * without the other.
 *
 * `test` is deliberately NOT owned here even though `scripts/gate.ts` runs it — the gate declares
 * WHICH checks run, while the base module supplies the test runner that backs one of them.
 */
export const gateModule: ProjectModule = {
  name: 'gate',

  documentation: {
    path: 'docs/the-gate.md',
    title: 'The gate',
    summary: 'One ordered check list, how to add a check, and what the naming plugin enforces.',
  },

  isSelected(): boolean {
    return true
  },

  packageJsonFragment(answers: ProjectAnswers): PackageJsonFragment {
    return {
      scripts: {
        lint: 'biome check',
        'lint:fix': 'biome check --write',
        format: 'biome format --write',
        typecheck: 'tsc --noEmit',
        // The gate runner is itself TypeScript, so it needs the runtime's `.ts` execution prefix.
        'check:all': `${typescriptRunnerPrefix(answers.packageManager)} scripts/gate.ts`,
      },
      devDependencies: {
        '@biomejs/biome': BIOME_VERSION,
        typescript: TYPESCRIPT_VERSION,
      },
    }
  },
}
