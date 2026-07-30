import {
  isBunRuntime,
  typescriptRunnerPrefix,
  type PackageJsonFragment,
  type ProjectAnswers,
  type ProjectModule,
} from '../module-contract.js'

/** Node 24 is the floor because the project runs `.ts` without a build step, and native
 * type-stripping is only stable from 23.6 onward — 24 is the first LTS line that has it. */
const NODE_ENGINE_RANGE = '>=24'

const TSX_VERSION = '^4.23.1'

/**
 * The Node runtime — selected for EVERY manager that runs on Node, which today means npm and pnpm.
 *
 * Keyed off the runtime rather than a single manager on purpose. npm and pnpm need exactly the same two
 * things (the engine floor and tsx) and nothing else; giving each its own copy would duplicate them, and
 * a third Node manager would duplicate them again. The manager-specific half — install commands, which
 * lockfile is committed, the CI setup steps — lives in the `npm` and `pnpm` modules.
 *
 * tsx is load-bearing, not ceremony: Node's own resolver does not read tsconfig `paths`, so the first
 * `@/*` import under bare `node` throws ERR_MODULE_NOT_FOUND. Since the generated project ships those
 * aliases, dropping tsx breaks it on the first aliased import.
 *
 * Contributes only its document as a file. The CI workflow used to live here, which was wrong twice
 * over: it is needed under Bun too, and it varies by MANAGER rather than by runtime. It is now a single
 * rendered template in the base module.
 */
export const nodeModule: ProjectModule = {
  name: 'node',

  documentation: {
    path: 'docs/node-runtime.md',
    title: 'Running on Node',
    summary: 'Why tsx is load-bearing, and what bare Node cannot do with this tsconfig.',
  },

  isSelected(answers: ProjectAnswers): boolean {
    return !isBunRuntime(answers.packageManager)
  },

  templateData(answers: ProjectAnswers): Readonly<Record<string, unknown>> {
    return {
      isBunRuntime: false,
      /** Reuses the shared helper rather than restating the string — one source of truth. */
      typescriptRunner: typescriptRunnerPrefix(answers.packageManager),
      /**
       * Whether `coverage-main.yml` ships. Node-only for now, which is a limitation rather than a
       * principle: the workflow commits a refreshed COVERAGE.md back to main, and it is now
       * manager-agnostic, so bun + Vitest could have it too. Tracked as issue #3.
       */
      hasCoverageWorkflow: true,
    }
  },

  packageJsonFragment(): PackageJsonFragment {
    return {
      engines: { node: NODE_ENGINE_RANGE },
      devDependencies: { tsx: TSX_VERSION },
    }
  },
}
