import type { PackageJsonFragment, ProjectAnswers, ProjectModule } from '../module-contract.js'

/** Node 24 is the floor because the project runs `.ts` without a build step, and native
 * type-stripping is only stable from 23.6 onward — 24 is the first LTS line that has it. */
const NODE_ENGINE_RANGE = '>=24'

const TSX_VERSION = '^4.23.1'

/**
 * The Node runtime module — selected when `projectRuntime` is `node`.
 *
 * Contributes no files at all, only the two things that make `.ts` executable under Node: the
 * engine floor and tsx. Everything about TESTING lives in the base module, because the recommended
 * Bun path keeps Vitest too — the runtime modules differ only in how a `.ts` file gets executed,
 * not in what runs the tests.
 *
 * tsx is load-bearing, not ceremony: Node's own resolver does not read tsconfig `paths`, so the
 * first `@/*` import under bare `node` throws ERR_MODULE_NOT_FOUND. Since the generated project
 * ships those aliases, dropping tsx breaks it on the first aliased import.
 */
export const nodeModule: ProjectModule = {
  name: 'node',

  documentation: {
    path: 'docs/node-runtime.md',
    title: 'Running on Node',
    summary: 'Why tsx is load-bearing, and what bare Node cannot do with this tsconfig.',
  },

  isSelected(answers: ProjectAnswers): boolean {
    return answers.projectRuntime === 'node'
  },

  packageJsonFragment(): PackageJsonFragment {
    return {
      engines: { node: NODE_ENGINE_RANGE },
      devDependencies: { tsx: TSX_VERSION },
    }
  },
}
