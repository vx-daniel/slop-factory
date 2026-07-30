import { defineConfig } from 'vitest/config'
import { MODULE_COPY_TREE_DIRECTORY_NAMES } from './modules/module-contract.js'

/**
 * A generation test installs dependencies and runs the generated project's full gate plus coverage,
 * for one combination. That is minutes of real work, not the seconds Vitest defaults to — so the
 * timeout is stated per project rather than globally, keeping the unit project's fast-failure
 * behaviour intact.
 */
const GENERATION_TIMEOUT_MS = 600_000

export default defineConfig({
  test: {
    // Two projects, split by COST, because that split decides what gets run habitually.
    //
    //   unit       — pure functions, no I/O, milliseconds. This is the package.json merge and render
    //                logic: the part most likely to regress and the cheapest to check.
    //   generation — generates real projects, installs them, runs their gate. Minutes. It is the only
    //                thing that can catch a fragment merge producing a project whose dependencies do
    //                not satisfy its own scripts, or a file rendered when it should have been copied
    //                verbatim (Handlebars and GitHub Actions both claim `{{ }}`). Both of those
    //                install and typecheck cleanly, so nothing cheaper sees them.
    //
    // Bundling the fast checks behind the slow ones means nobody runs either.
    projects: [
      {
        test: {
          name: 'unit',
          include: ['modules/**/*.test.ts'],
          // Excluded for the same reason tsconfig.json excludes them: files under a module's COPY TREES
          // are TEMPLATES destined for a generated project, and they run against THAT project's
          // dependencies. `modules/config/packageSource/src/config/config.test.ts` imports zod and
          // smol-toml, which the factory does not install — so collecting them here fails on imports
          // that are correct where the files actually live.
          //
          // DERIVED from the contract rather than listed, unlike the three JSON configs that cannot
          // import it. Adding a copy tree covers this file automatically.
          exclude: MODULE_COPY_TREE_DIRECTORY_NAMES.map(
            (copyTreeDirectoryName) => `modules/*/${copyTreeDirectoryName}/**`,
          ),
        },
      },
      {
        test: {
          // Reads the generator's prompt list without answering it. Cheap, but it needs the BUILT
          // plopfile (node-plop imports it through Node), so it cannot live in the unit project.
          name: 'prompts',
          include: ['tests/prompts.test.ts'],
        },
      },
      {
        test: {
          name: 'packaging',
          include: ['tests/packaging.test.ts'],
          // Runs `npm run build` in a hook before asserting on the tarball.
          testTimeout: GENERATION_TIMEOUT_MS,
          hookTimeout: GENERATION_TIMEOUT_MS,
        },
      },
      {
        test: {
          name: 'generation',
          include: ['tests/generation.test.ts'],
          testTimeout: GENERATION_TIMEOUT_MS,
          hookTimeout: GENERATION_TIMEOUT_MS,
          // Each case runs a package manager install in its own tree. Running them concurrently
          // contends on the npm/bun cache and makes failures non-reproducible, which is the opposite
          // of what a verification suite is for.
          fileParallelism: false,
        },
      },
    ],
  },
})
