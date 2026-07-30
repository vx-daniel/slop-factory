import { existsSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { NodePlopAPI } from 'plop'
import {
  mergePackageJsonFragments,
  mergeTemplateData,
  type PackageJsonFragment,
  type ProjectAnswers,
  PACKAGE_MANAGERS,
  type PackageManager,
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
 * Rejects a package-manager answer that is missing or not one the factory knows.
 *
 * This exists because the failure it prevents is SILENT. Every manager-specific contribution — the
 * install commands, the lockfile rule, the CI setup steps — and every runtime-specific one — `engines`,
 * tsx — comes from a module selected by an equality test against this value. An `undefined` manager
 * satisfies none of them, so the generator cheerfully produces a project with no manager and no runtime
 * module: no `engines`, no tsx, and a `check:all` that fails on the first run with
 * `Cannot find package 'tsx'`. Nothing upstream complains, because a cast is a claim rather than a check.
 *
 * Found the hard way: deleting the runtime PROMPT while refactoring produced exactly that project, and
 * the generation suite did not notice — it supplies answers directly and never runs the prompts, so the
 * only thing that would have caught it is a check here.
 */
function assertKnownPackageManager(rawManager: unknown): PackageManager {
  if (!PACKAGE_MANAGERS.some((knownManager) => knownManager === rawManager)) {
    throw new Error(
      `packageManager must be one of ${PACKAGE_MANAGERS.join(', ')} but was ${JSON.stringify(rawManager)}. ` +
        'If this came from the generator, its package-manager prompt is missing or renamed — without a ' +
        'manager module the project has no install commands, no engines field, and no CI workflow.',
    )
  }
  return rawManager as PackageManager
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
  const packageManager = assertKnownPackageManager(rawAnswers.packageManager)

  return {
    projectName: String(rawAnswers.projectName).trim(),
    // Resolved against the operator's cwd here, once, so every module and action downstream can treat
    // it as absolute. `.` — the default answer — therefore means "the directory I ran this from".
    projectPath: path.resolve(String(rawAnswers.projectPath).trim()),
    packageManager,
    // Forced rather than trusted for npm and pnpm: `bun test` ships with the Bun runtime, so the prompt
    // is skipped for them and the answer would be `undefined`. Normalizing here means no module has to
    // defend against that combination.
    testRunner: packageManager === 'bun' ? assertKnownTestRunner(rawAnswers.testRunner) : 'vitest',
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
      // ONE question, not two. The manager determines the runtime — see PACKAGE_MANAGERS in
      // module-contract.ts for why modelling them separately was rejected.
      {
        type: 'list',
        name: 'packageManager',
        message: 'Which package manager?',
        choices: [
          { name: 'npm  — Node 24, .ts through tsx, package-lock.json', value: 'npm' },
          { name: 'pnpm — Node 24, .ts through tsx, strict store, pnpm-lock.yaml', value: 'pnpm' },
          { name: 'bun  — Bun runtime, .ts natively, bun.lock', value: 'bun' },
        ],
      },
      // Asked only for bun, because `bun test` ships with the Bun runtime — an npm or pnpm project has
      // exactly one possible answer, and a question with one answer is noise. `toProjectAnswers` forces
      // `vitest` in that case.
      {
        type: 'list',
        name: 'testRunner',
        message: 'Which test runner? (Bun ships its own; Vitest keeps full coverage)',
        when: (answers): boolean => answers.packageManager === 'bun',
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

      /**
       * The data every rendered template sees.
       *
       * Almost all of it is CONTRIBUTED BY MODULES — `usesVitest` by the runner modules, the
       * package-manager commands by the runtime modules, `hasConfigModule` by config. This function
       * used to assemble those centrally, which meant the generator branched on the runtime and on
       * which modules were present, duplicating knowledge that already had an owner.
       *
       * Only two keys are genuinely the generator's, because neither belongs to any single module:
       * the project's name, and the docs index rows, which describe the SET of selected modules.
       */
      const templateData = {
        projectName: answers.projectName,
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
        ...mergeTemplateData(
          selectedModules
            .filter((projectModule) => projectModule.templateData !== undefined)
            .map((projectModule) => ({
              moduleName: projectModule.name,
              data: projectModule.templateData?.(answers) ?? {},
            })),
        ),
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

        // Every module's rendered templates, declared by the module rather than listed here. These DO
        // go through Handlebars, which is why they live outside any module's `source/` tree — the two
        // channels stay physically separate so a file cannot be rendered by accident.
        //
        // `path` is absolute, which plop resolves as-is; it is ALSO rendered, so a module may emit into
        // a directory named after an answer. `templateFile` is relative to this plopfile.
        ...selectedModules.flatMap((projectModule) =>
          (projectModule.renderedTemplates?.(answers) ?? []).map((template) => ({
            type: 'add',
            path: path.join(destinationDirectory, template.outputPath),
            templateFile: template.templateFile,
            data: templateData,
          })),
        ),
      ]
    },
  })
}
