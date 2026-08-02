import { defineConfig } from 'vitest/config'
import { MODULE_COPY_TREE_DIRECTORY_NAMES } from './modules/module-contract.js'

/**
 * A generation test installs dependencies and runs the generated project's full gate plus coverage,
 * for one combination. That is minutes of real work, not the seconds Vitest defaults to — so the
 * timeout is stated per project rather than globally, keeping the unit project's fast-failure
 * behaviour intact.
 */
const GENERATION_TIMEOUT_MS = 600_000

/** Comfortably above `tests/drive-prompts.ts`'s per-prompt wait, so its diagnostic wins the race. */
const INTERACTIVE_TIMEOUT_MS = 30_000

export default defineConfig({
  test: {
    // Six projects, split by COST, because that split decides what gets run habitually. Listed roughly
    // cheapest-first, and each one's own comment below gives the reason it is separate rather than folded
    // into the project before it.
    //
    // The two ends are worth stating here. `unit` is pure functions and no I/O — milliseconds — covering
    // the package.json merge and render logic, the part most likely to regress and the cheapest to check.
    // `generation` generates real projects, installs them, and runs their gate: minutes, and the only
    // thing that can catch a fragment merge producing a project whose dependencies do not satisfy its own
    // scripts, or a file rendered when it should have been copied verbatim (Handlebars and GitHub Actions
    // both claim `{{ }}`). Both of those install and typecheck cleanly, so nothing cheaper sees them.
    //
    // Bundling the fast checks behind the slow ones means nobody runs either. `docs/verification.md`
    // tabulates what each suite proves, and `modules/vitest-projects-in-ci.test.ts` asserts that every
    // project named here is actually reached by the factory's own CI workflow.
    //
    // NO PROJECT MAY WRITE TO `dist/`. Vitest runs projects CONCURRENTLY, and five of the six below read
    // `dist/plopfile.js` or `dist/cli.js`. `npm run build` begins by deleting `dist/`, so a project that
    // built inside a hook would be wiping the artifact its siblings were mid-way through reading —
    // nondeterministically, and reported against the READER rather than the writer. `packaging` did
    // exactly that until #23; the build moved into `test:packaging`, where its four sibling scripts
    // already had it. The build is a precondition of running these suites, not a fixture any of them
    // sets up.
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
          // Two files, one subject: `prompts.test.ts` reads the prompt list as data, and
          // `prompt-session.test.ts` answers it with scripted keystrokes. Neither touches `cli.ts` — the
          // session harness drives the plopfile directly — so they belong here rather than in `cli`.
          include: ['tests/prompts.test.ts', 'tests/prompt-session.test.ts'],
          // Above the harness's own 5s wait for a prompt to render, so a mis-scripted flow reports the
          // transcript it captured rather than Vitest's generic "test timed out", which says nothing about
          // which question never appeared.
          testTimeout: INTERACTIVE_TIMEOUT_MS,
        },
      },
      {
        test: {
          // Spawns the published binary and asserts what it prints, to which stream, and its exit code.
          // Needs the BUILT cli, like `prompts` needs the built plopfile — `bin/slop-factory.mjs` loads
          // `dist/cli.js` and refuses if it is absent. A subprocess per case, so seconds rather than
          // milliseconds, which is why it is not folded into `unit`.
          name: 'cli',
          include: ['tests/cli.test.ts'],
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
          // Where the generator PLACES files, proved by generating into a temp directory and reading
          // the tree. Needs the built plopfile, like `prompts`, but installs nothing — so it stays
          // seconds rather than minutes and can assert layouts the generation suite cannot afford to.
          name: 'layout',
          include: ['tests/layout.test.ts'],
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
