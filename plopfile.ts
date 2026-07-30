import { existsSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { NodePlopAPI } from 'plop'
import {
  mergePackageJsonFragments,
  type PackageJsonFragment,
  type ProjectAnswers,
  PROJECT_RUNTIMES,
  type ProjectRuntime,
  renderPackageJson,
  TEST_RUNNERS,
  type TestRunner,
} from './modules/module-contract.js'
import { PROJECT_MODULES } from './modules/registry.js'

/** Custom action type that copies a module's `source/` tree verbatim. */
const COPY_MODULE_SOURCE = 'copyModuleSource'
/** Custom action type that writes the merged package.json. */
const WRITE_PACKAGE_JSON = 'writePackageJson'
/** Custom action type that refuses to generate into a non-empty directory. */
const ASSERT_EMPTY_DESTINATION = 'assertEmptyDestination'

/** Subdirectory of a module holding files copied verbatim into the generated project. */
const MODULE_SOURCE_DIRECTORY = 'source'

/**
 * Rejects a destination that is not an existing directory.
 *
 * Checked at the prompt rather than at write time so a typo costs one keystroke instead of aborting the
 * whole run after every other question has been answered. Creating a missing parent is deliberately NOT
 * offered: `npx slop-factory generate` answering "yes, and I built you three levels of directory you
 * did not ask for" is worse than making the operator confirm where they are.
 */
function validateDestinationDirectory(rawPath: string): true | string {
  const destinationParent = path.resolve(rawPath.trim())
  if (!existsSync(destinationParent)) {
    return `${destinationParent} does not exist. Create it first, or pick an existing directory.`
  }
  if (!statSync(destinationParent).isDirectory()) {
    return `${destinationParent} is a file, not a directory.`
  }
  return true
}

/**
 * A project name has to be a single directory name, because it is joined onto the chosen parent
 * directory to form the destination. Rejecting separators and dot-names here — rather than letting
 * `path.join` quietly interpret them — keeps a typo from creating a tree somewhere unexpected.
 */
function validateProjectName(rawName: string): true | string {
  const projectName = rawName.trim()
  if (projectName.length === 0) {
    return 'Project name cannot be empty.'
  }
  if (projectName.includes('/') || projectName.includes('\\')) {
    return 'Project name must be a single directory name, not a path.'
  }
  if (projectName === '.' || projectName === '..') {
    return 'Project name cannot be "." or "..".'
  }
  return true
}

/**
 * Rejects a runtime answer that is missing or not one the factory knows.
 *
 * This exists because the failure it prevents is SILENT. Every runtime-specific contribution — the
 * `engines` field, tsx, the CI workflow — comes from the `node` or `bun` module, and each is selected by
 * an equality test against this value. An `undefined` runtime satisfies neither, so the generator
 * cheerfully produces a project with no runtime module at all: no `engines`, no tsx, and a `check:all`
 * that fails on the first run with `Cannot find package 'tsx'`. Nothing upstream complains, because a
 * cast (`as ProjectRuntime`) is a claim rather than a check.
 *
 * Found the hard way: deleting the runtime PROMPT while refactoring produced exactly that project, and
 * the generation suite did not notice — it supplies answers directly and never runs the prompts, so the
 * only thing that would have caught it is a check here.
 */
function assertKnownRuntime(rawRuntime: unknown): ProjectRuntime {
  if (!PROJECT_RUNTIMES.some((knownRuntime) => knownRuntime === rawRuntime)) {
    throw new Error(
      `projectRuntime must be one of ${PROJECT_RUNTIMES.join(', ')} but was ${JSON.stringify(rawRuntime)}. ` +
        'If this came from the generator, its runtime prompt is missing or renamed — without a runtime ' +
        'module the project ships with no engines field and no way to execute its TypeScript.',
    )
  }
  return rawRuntime as ProjectRuntime
}

/**
 * Rejects a test-runner answer that is missing or unknown, for the same reason as the runtime.
 *
 * Only checked under Bun: the prompt is deliberately skipped for Node, where `vitest` is the only
 * possible answer, so `undefined` there is expected and normalized rather than rejected.
 */
function assertKnownTestRunner(rawTestRunner: unknown): TestRunner {
  if (!TEST_RUNNERS.some((knownRunner) => knownRunner === rawTestRunner)) {
    throw new Error(
      `testRunner must be one of ${TEST_RUNNERS.join(', ')} but was ${JSON.stringify(rawTestRunner)}. ` +
        'Without a test-runner module the project has no `test` script for its own gate to run.',
    )
  }
  return rawTestRunner as TestRunner
}

/**
 * Narrows plop's untyped answers object to the typed shape the modules consume.
 *
 * Plop hands `actions()` a plain `Record<string, unknown>`; every module then reads it as
 * `ProjectAnswers`. Doing the narrowing once, here, means a prompt renamed without updating a module
 * fails in one obvious place instead of surfacing as an `undefined` deep inside a fragment.
 */
function toProjectAnswers(rawAnswers: Record<string, unknown>): ProjectAnswers {
  const projectRuntime = assertKnownRuntime(rawAnswers.projectRuntime)

  return {
    projectName: String(rawAnswers.projectName).trim(),
    // Resolved against the operator's cwd here, once, so every module and action downstream can treat
    // it as absolute. `.` — the default answer — therefore means "the directory I ran this from".
    projectPath: path.resolve(String(rawAnswers.projectPath).trim()),
    projectRuntime,
    // Forced rather than trusted for Node: `bun test` requires the Bun runtime, so the prompt is
    // skipped entirely under Node and the answer would be `undefined`. Normalizing here means no
    // module has to defend against that combination.
    testRunner: projectRuntime === 'bun' ? assertKnownTestRunner(rawAnswers.testRunner) : 'vitest',
    enableFeatures: Array.isArray(rawAnswers.enableFeatures)
      ? (rawAnswers.enableFeatures as string[])
      : [],
  }
}


/**
 * Where the generated project is written.
 *
 * `projectPath` is already absolute by the time it gets here (`toProjectAnswers` resolves it against
 * the operator's cwd), so it is used directly and never joined under anything else. Joining it under
 * the factory's own directory was the original defect: the generator wrote into `slop-factory/src/…`,
 * generating into itself.
 */
function resolveDestinationDirectory(answers: ProjectAnswers): string {
  return path.resolve(answers.projectPath, answers.projectName)
}

export default async function plopfile(plop: NodePlopAPI): Promise<void> {
  /**
   * The factory's own directory — the root every module `source/` tree is read FROM.
   *
   * Deliberately derived from the plopfile's location, never from `process.cwd()`. cwd is where the
   * operator happened to be standing; it has no relationship to where the templates live, and using
   * it for both reading templates and writing output is what made the two roots collapse into one.
   */
  const factoryRoot = plop.getPlopfilePath()

  plop.setActionType(ASSERT_EMPTY_DESTINATION, async (_answers, config) => {
    const { destinationDirectory } = config as unknown as { destinationDirectory: string }
    let existingEntries: string[]
    try {
      existingEntries = await fs.readdir(destinationDirectory)
    } catch (error) {
      // ENOENT is the expected, good case: the directory does not exist yet and will be created.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return `destination is new: ${destinationDirectory}`
      }
      throw error
    }
    if (existingEntries.length > 0) {
      throw new Error(
        `refusing to generate into non-empty directory ${destinationDirectory} ` +
          `(${existingEntries.length} existing entries). Choose another name or clear it first.`,
      )
    }
    return `destination is empty: ${destinationDirectory}`
  })

  /**
   * Copies one module's `source/` tree verbatim.
   *
   * NOTHING here is rendered, and that is the point — see `module-contract.ts`. `fs.cp` preserves
   * file modes, which `.githooks/pre-commit` depends on: copied without its executable bit, git
   * silently declines to run the hook and the pre-commit gate is quietly absent.
   *
   * A module with no `source/` directory is legitimate (the runtime modules contribute only
   * package.json fragments), so a missing directory is reported, not failed.
   */
  plop.setActionType(COPY_MODULE_SOURCE, async (_answers, config) => {
    const { moduleName, destinationDirectory } = config as unknown as {
      moduleName: string
      destinationDirectory: string
    }
    const moduleSourceDirectory = path.join(
      factoryRoot,
      'modules',
      moduleName,
      MODULE_SOURCE_DIRECTORY,
    )
    try {
      await fs.access(moduleSourceDirectory)
    } catch {
      return `${moduleName}: no source/ tree, package.json fragment only`
    }
    await fs.cp(moduleSourceDirectory, destinationDirectory, { recursive: true })
    return `${moduleName}: copied source/ tree`
  })

  /**
   * Merges the selected modules' fragments and writes package.json.
   *
   * Written by a custom action rather than plop's `add` because the content must land byte-for-byte
   * as `JSON.stringify` produced it. Routing it through `add` would pass the JSON through Handlebars
   * first, which is a needless rendering pass over generated content.
   */
  plop.setActionType(WRITE_PACKAGE_JSON, async (_answers, config) => {
    const { projectName, fragments, destinationDirectory } = config as unknown as {
      projectName: string
      fragments: ReadonlyArray<{ moduleName: string; fragment: PackageJsonFragment }>
      destinationDirectory: string
    }
    const merged = mergePackageJsonFragments(fragments)
    const packageJsonPath = path.join(destinationDirectory, 'package.json')
    await fs.mkdir(destinationDirectory, { recursive: true })
    await fs.writeFile(packageJsonPath, renderPackageJson({ projectName, merged }), 'utf8')
    return `wrote package.json (${Object.keys(merged.scripts ?? {}).length} scripts)`
  })

  plop.setGenerator('generate', {
    description: 'Generate a new TypeScript project from the factory modules',
    prompts: [
      {
        type: 'input',
        name: 'projectName',
        message: 'Name of the project (also the directory name)',
        validate: validateProjectName,
      },
      {
        type: 'input',
        name: 'projectPath',
        message: 'Directory to create it in',
        default: '.',
        validate: validateDestinationDirectory,
      },
      {
        type: 'list',
        name: 'projectRuntime',
        message: 'Which runtime will this project use?',
        choices: [
          { name: 'Node.js 24 (npm, runs .ts through tsx)', value: 'node' },
          { name: 'Bun (runs .ts natively, keeps Vitest)', value: 'bun' },
        ],
      },
      // Asked only under Bun, because `bun test` needs the Bun runtime — a Node project has exactly
      // one possible answer, and a question with one answer is noise. `toProjectAnswers` forces
      // `vitest` in that case.
      {
        type: 'list',
        name: 'testRunner',
        message: 'Which test runner? (Bun ships its own; Vitest keeps full coverage)',
        when: (answers) => answers.projectRuntime === 'bun',
        choices: [
          {
            name: 'Vitest — recommended: 4 coverage metrics, COVERAGE.md, passWithNoTests',
            value: 'vitest',
          },
          {
            name: 'bun test — no dependency, but coverage drops to funcs+lines only',
            value: 'bun-test',
          },
        ],
      },
      {
        type: 'checkbox',
        name: 'enableFeatures',
        message: 'Which optional features should be enabled?',
        choices: [{ name: 'Layered TOML config (Zod-validated)', value: 'config', checked: true }],
      },
    ],

    actions: (rawAnswers) => {
      const answers = toProjectAnswers(rawAnswers as Record<string, unknown>)
      const destinationDirectory = resolveDestinationDirectory(answers)
      const selectedModules = PROJECT_MODULES.filter((projectModule) =>
        projectModule.isSelected(answers),
      )

      const isBunRuntime = answers.projectRuntime === 'bun'

      /**
       * The values the rendered documentation templates read. Built once and shared by every `add`
       * action below — three copies of this object was the first duplication the factory grew, and
       * each copy is a chance for one document to describe a different project than its neighbour.
       */
      const templateData = {
        projectName: answers.projectName,
        isBunRuntime,
        /** Drives the coverage sections: `bun test` ships no COVERAGE.md pipeline. */
        usesVitest: answers.testRunner === 'vitest',
        /**
         * Whether `coverage-main.yml` ships. It is both Vitest-specific and npm-specific, and Node
         * always implies Vitest, so it lives in the node module — which makes the runtime, not the
         * runner, the condition. Bun projects refresh COVERAGE.md locally instead.
         */
        hasCoverageWorkflow: answers.projectRuntime === 'node',
        hasConfigModule: selectedModules.some((projectModule) => projectModule.name === 'config'),
        /** Prefix for running a package.json script, e.g. "npm run check:all". */
        runCommand: isBunRuntime ? 'bun run' : 'npm run',
        /** Command that installs dependencies. */
        installCommand: isBunRuntime ? 'bun install' : 'npm install',
        /**
         * Rows for the generated `docs/README.md` index — one per selected module.
         *
         * `fileName` is the basename rather than the full `docs/…` path because the index lives
         * inside `docs/`, so its links are siblings.
         */
        documentedModules: selectedModules.map((projectModule) => ({
          title: projectModule.documentation.title,
          summary: projectModule.documentation.summary,
          fileName: path.basename(projectModule.documentation.path),
        })),
      }

      return [
        { type: ASSERT_EMPTY_DESTINATION, destinationDirectory },

        ...selectedModules.map((projectModule) => ({
          type: COPY_MODULE_SOURCE,
          moduleName: projectModule.name,
          destinationDirectory,
        })),

        {
          type: WRITE_PACKAGE_JSON,
          projectName: answers.projectName,
          destinationDirectory,
          fragments: selectedModules.map((projectModule) => ({
            moduleName: projectModule.name,
            fragment: projectModule.packageJsonFragment(answers),
          })),
        },

        // The rendered templates. These DO go through Handlebars, which is why they live outside any
        // module's `source/` tree — the two channels stay physically separate so a file cannot be
        // rendered by accident. `path` is absolute, which plop resolves as-is; `templateFile` is
        // relative to this plopfile.
        {
          type: 'add',
          path: path.join(destinationDirectory, '.gitignore'),
          templateFile: 'modules/base/gitignore.hbs',
          data: templateData,
        },
        // tsconfig is rendered because two of its fields depend on the test runner: `types` needs
        // `bun` under `bun test`, and `include` must not name a vitest.config.ts that is not there.
        {
          type: 'add',
          path: path.join(destinationDirectory, 'tsconfig.json'),
          templateFile: 'modules/base/tsconfig.json.hbs',
          data: templateData,
        },
        {
          type: 'add',
          path: path.join(destinationDirectory, 'CLAUDE.md'),
          templateFile: 'modules/base/CLAUDE.md.hbs',
          data: templateData,
        },
        {
          type: 'add',
          path: path.join(destinationDirectory, 'README.md'),
          templateFile: 'modules/base/README.md.hbs',
          data: templateData,
        },
        // The docs index. Each module's own document arrives verbatim via its `source/docs/` tree;
        // only this index needs rendering, because it is the one file whose content depends on WHICH
        // modules were selected.
        {
          type: 'add',
          path: path.join(destinationDirectory, 'docs', 'README.md'),
          templateFile: 'modules/base/docs-index.md.hbs',
          data: templateData,
        },
      ]
    },
  })
}
