import { existsSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { NodePlopAPI } from 'plop'
import { CLAUDE_WORKFLOWS_FEATURE } from './modules/claude-workflows/module.js'
import {
  DEFAULT_FIRST_PACKAGE_NAME,
  DEFAULT_PROJECT_STRUCTURE,
  MODULE_COPY_TREES,
  mergePackageJsonFragments,
  mergeTemplateData,
  PACKAGE_MANAGERS,
  type PackageJsonFragment,
  type PackageManager,
  PROJECT_STRUCTURES,
  type ProjectAnswers,
  type ProjectStructure,
  packageRootRelativePath,
  renderPackageJson,
  TEST_RUNNERS,
  type TestRunner,
} from './modules/module-contract.js'
import { PROJECT_MODULES } from './modules/registry.js'

/** Custom action type that copies one of a module's verbatim-copy trees. */
const COPY_MODULE_SOURCE = 'copyModuleSource'
/** Custom action type that writes the merged package.json. */
const WRITE_PACKAGE_JSON = 'writePackageJson'
/** Custom action type that refuses to generate into a non-empty directory. */
const ASSERT_EMPTY_DESTINATION = 'assertEmptyDestination'

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

/** How the package-names prompt separates one name from the next. */
const PACKAGE_NAME_SEPARATOR = ','

/**
 * Splits the comma-separated package-names answer, dropping whitespace and empty entries.
 *
 * Dropping empties is not tidiness — it is the guard against `packages//package.json`. `"core, api,"` and
 * `"core,,api"` are both things an operator types, and an untrimmed empty segment would become a path
 * segment with no name. Shared by the prompt validator and the normalizer so the two cannot disagree
 * about what the operator typed.
 */
function splitPackageNames(rawAnswer: string): string[] {
  return rawAnswer
    .split(PACKAGE_NAME_SEPARATOR)
    .map((packageName) => packageName.trim())
    .filter((packageName) => packageName.length > 0)
}

/**
 * Rejects a package name that would not be a single directory under `packages/`.
 *
 * Returns the reason rather than throwing, so both callers can present it their own way: the prompt
 * declines the answer, the normalizer throws. Every rule lives HERE rather than in either caller, which is
 * what stops the two input shapes — the prompt's comma-separated string and a caller's array — from
 * enforcing different things.
 */
function findPackageNameProblem(packageName: string): string | undefined {
  if (packageName.includes('/') || packageName.includes('\\')) {
    return `"${packageName}" must be a single directory name, not a path.`
  }
  if (packageName.startsWith('.')) {
    return `"${packageName}" cannot start with a dot.`
  }
  // Unreachable from the PROMPT, whose answer is split on this character before it ever gets here — and
  // reachable from an ARRAY caller, which is exactly why the check belongs in the shared predicate rather
  // than in the split. `packageNames: ['core,api']` used to generate a directory literally named
  // `core,api`, an npm name of `@project/core,api`, and an alias of `@core,api/*`: three invalid artifacts
  // written silently, which is `packages/undefined/` wearing a different costume.
  if (packageName.includes(PACKAGE_NAME_SEPARATOR)) {
    return `"${packageName}" cannot contain "${PACKAGE_NAME_SEPARATOR}" — that separates one name from the next.`
  }
  return undefined
}

/**
 * Rejects a repeated name, because two packages cannot share a directory.
 *
 * Rejected rather than silently deduplicated, matching how the factory treats every other collision (see
 * `mergePackageJsonFragments`): a duplicate means the operator meant something the generator cannot
 * deliver, and quietly producing one package where they asked for two hides it. It also matters
 * downstream — two identical tsconfig `paths` keys are last-one-wins with no warning from tsc.
 */
function findDuplicatePackageName(packageNames: readonly string[]): string | undefined {
  const seenPackageNames = new Set<string>()
  for (const packageName of packageNames) {
    if (seenPackageNames.has(packageName)) {
      return packageName
    }
    seenPackageNames.add(packageName)
  }
  return undefined
}

/**
 * Rejects the package-names answer at the PROMPT, so a typo costs one keystroke.
 *
 * Duplicates the checks in `normalizePackageNames` on purpose — that one is the backstop for callers that
 * bypass prompts entirely (the example and drift scripts), and throwing there mid-generation is a worse
 * experience than declining the answer here. Both delegate to the same two predicates, so the rules are
 * written once even though they are enforced twice.
 */
function validatePackageNames(rawAnswer: string): true | string {
  const packageNames = splitPackageNames(rawAnswer)
  if (packageNames.length === 0) {
    return 'Name at least one package.'
  }
  for (const packageName of packageNames) {
    const problem = findPackageNameProblem(packageName)
    if (problem !== undefined) {
      return problem
    }
  }
  const duplicateName = findDuplicatePackageName(packageNames)
  if (duplicateName !== undefined) {
    return `"${duplicateName}" is named twice — two packages cannot share a directory.`
  }
  return true
}

/**
 * Rejects a project-structure answer that is unknown.
 *
 * Throws rather than falling back to `single`. A silent fallback is exactly how a rename of the
 * `projectStructure` prompt would produce single-package projects forever while still appearing to offer
 * the choice — the same class of failure as the runtime prompt that was deleted during a refactor with
 * all 87 generation assertions still passing.
 */
function assertKnownProjectStructure(rawStructure: unknown): ProjectStructure {
  if (!PROJECT_STRUCTURES.some((knownStructure) => knownStructure === rawStructure)) {
    throw new Error(
      `projectStructure must be one of ${PROJECT_STRUCTURES.join(', ')} but was ` +
        `${JSON.stringify(rawStructure)}. This decides whether the package's source lands at the ` +
        'project root or under packages/<name>/, so a wrong value misplaces every source file.',
    )
  }
  return rawStructure as ProjectStructure
}

/**
 * Normalizes the package names, falling back to the default when none were given.
 *
 * ACCEPTS TWO SHAPES, because it has two kinds of caller. The prompt produces one comma-separated STRING,
 * which is the only repeat-free form inquirer offers (plop exposes `input`, `list` and `checkbox` — none
 * of them repeat until blank). The example and drift scripts, and the test harness, call `runActions`
 * directly and pass an ARRAY, which is the shape they already hold.
 *
 * NEVER RETURNS AN EMPTY LIST. That is the load-bearing part: `ProjectAnswers.packageNames` is typed
 * `readonly string[]`, which cannot express "at least one", so this function and `resolveFirstPackageName`
 * are the two places the guarantee is kept. An empty answer means "the operator pressed Enter", not "zero
 * packages", and the default is what they asked for.
 *
 * Unlike the `assertKnown*` guards this does NOT throw on a missing value: the prompt that produces it is
 * asked only for a monorepo, so under `single` there is legitimately no answer and the field is unused. It
 * does reject a value that would build a broken path: a package name is one directory segment, and letting
 * `packages/../..` through `path.join` is how a generator writes outside its own destination.
 */
function normalizePackageNames(rawPackageNames: unknown): readonly string[] {
  const packageNames = Array.isArray(rawPackageNames)
    ? rawPackageNames.map((packageName) => String(packageName).trim()).filter((packageName) => packageName.length > 0)
    : splitPackageNames(rawPackageNames === undefined || rawPackageNames === null ? '' : String(rawPackageNames))

  if (packageNames.length === 0) {
    return [DEFAULT_FIRST_PACKAGE_NAME]
  }

  for (const packageName of packageNames) {
    const problem = findPackageNameProblem(packageName)
    if (problem !== undefined) {
      throw new Error(
        `packageNames must each be a single directory name: ${problem} ` +
          'Separators and dot-names would place the package outside packages/.',
      )
    }
  }

  const duplicateName = findDuplicatePackageName(packageNames)
  if (duplicateName !== undefined) {
    throw new Error(
      `packageNames repeats ${JSON.stringify(duplicateName)}. Two packages cannot share a directory, ` +
        'and two identical tsconfig `paths` keys are silently last-one-wins.',
    )
  }

  return packageNames
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
    // The default applies only when nothing supplied a value — the drift-check and example scripts call
    // `runActions` directly and legitimately omit it. A prompt answer is always present, so this is not
    // a fallback that can mask a renamed prompt; `assertKnownProjectStructure` throws on anything else.
    projectStructure: assertKnownProjectStructure(rawAnswers.projectStructure ?? DEFAULT_PROJECT_STRUCTURE),
    packageNames: normalizePackageNames(rawAnswers.packageNames),
    enableFeatures: Array.isArray(rawAnswers.enableFeatures) ? (rawAnswers.enableFeatures as string[]) : [],
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
    const { moduleName, copyTreeDirectoryName, destinationDirectory } = config as unknown as {
      moduleName: string
      copyTreeDirectoryName: string
      destinationDirectory: string
    }
    const moduleCopyTreeDirectory = path.join(factoryRoot, 'modules', moduleName, copyTreeDirectoryName)
    // A module shipping only SOME of the copy trees is the normal case, not an error — `npm` and `pnpm`
    // have no `packageSource/` at all, and most modules have no package-relative source either.
    try {
      await fs.access(moduleCopyTreeDirectory)
    } catch {
      return `${moduleName}: no ${copyTreeDirectoryName}/ tree, nothing to copy`
    }
    await fs.cp(moduleCopyTreeDirectory, destinationDirectory, { recursive: true })
    return `${moduleName}: copied ${copyTreeDirectoryName}/ tree`
  })

  /**
   * Merges the selected modules' fragments and writes package.json.
   *
   * Written by a custom action rather than plop's `add` because the content must land byte-for-byte
   * as `JSON.stringify` produced it. Routing it through `add` would pass the JSON through Handlebars
   * first, which is a needless rendering pass over generated content.
   */
  plop.setActionType(WRITE_PACKAGE_JSON, async (_answers, config) => {
    const { projectName, fragments, destinationDirectory, projectStructure } = config as unknown as {
      projectName: string
      fragments: ReadonlyArray<{ moduleName: string; fragment: PackageJsonFragment }>
      destinationDirectory: string
      projectStructure: ProjectStructure
    }
    const merged = mergePackageJsonFragments(fragments)
    const packageJsonPath = path.join(destinationDirectory, 'package.json')
    await fs.mkdir(destinationDirectory, { recursive: true })
    await fs.writeFile(
      packageJsonPath,
      // `projectStructure` decides only whether a `workspaces` field is written — see
      // `renderPackageJson`, which owns that field rather than any module.
      renderPackageJson({ projectName, merged, projectStructure }),
      'utf8',
    )
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
        name: 'projectStructure',
        message: 'Which layout?',
        choices: [
          { name: 'single   — one package, source at src/', value: 'single' },
          { name: 'monorepo — a workspace, source at packages/<name>/src/', value: 'monorepo' },
        ],
      },
      // Asked only for a workspace, because `single` has no packages directory for the answer to name.
      //
      // NAMES, COMMA-SEPARATED — not a count. A count would force the generator to invent `package-2`,
      // and having to guess names is the reason generating more than one was deferred in the first place.
      // One `input` is the plainest form available: plop exposes only inquirer's `input`, `list` and
      // `checkbox`, none of which repeat until blank, and registering a third-party repeat prompt through
      // `plop.setPrompt` would buy a dependency for prompt ergonomics alone.
      //
      // The FIRST name is not merely first: it is where every module's `packageSource/` tree lands. See
      // `resolveFirstPackageName` for why one recipient is sufficient.
      {
        type: 'input',
        name: 'packageNames',
        message: 'Names of the packages to create under packages/ (comma-separated)',
        default: DEFAULT_FIRST_PACKAGE_NAME,
        when: (answers): boolean => answers.projectStructure === 'monorepo',
        validate: validatePackageNames,
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
        choices: [
          { name: 'Layered TOML config (Zod-validated)', value: 'config', checked: true },
          {
            // Unchecked by default: each needs a CLAUDE_CODE_OAUTH_TOKEN repository secret, and
            // shipping ~700 lines of workflow that is inert without one is worse than not shipping it.
            name: 'Claude workflows — PR review, issue triage, test audit (needs CLAUDE_CODE_OAUTH_TOKEN)',
            value: CLAUDE_WORKFLOWS_FEATURE,
            checked: false,
          },
        ],
      },
    ],

    actions: (rawAnswers) => {
      const answers = toProjectAnswers(rawAnswers as Record<string, unknown>)
      const destinationDirectory = resolveDestinationDirectory(answers)
      const selectedModules = PROJECT_MODULES.filter((projectModule) => projectModule.isSelected(answers))

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

      /**
       * Where each copy tree's contents land.
       *
       * Under `single` the two are the SAME directory, which is what makes the `packageSource/` split a
       * provable no-op there — `examples:check` shows zero drift. Under `monorepo` the package root
       * becomes `packages/<name>/`, and the split starts doing visible work: config's `src/config/**`
       * moves while its TOMLs and docs stay at the repository root.
       *
       * `packageRootRelativePath` returns `.` for `single`, so `path.join` collapses it back to the
       * destination directory rather than appending anything.
       */
      const copyDestinations: Readonly<Record<string, string>> = {
        projectRoot: destinationDirectory,
        packageRoot: path.join(destinationDirectory, packageRootRelativePath(answers)),
      }

      return [
        { type: ASSERT_EMPTY_DESTINATION, destinationDirectory },

        // Every module × every copy tree. A module missing a given tree is skipped by the action itself
        // rather than filtered here, so the generator needs no knowledge of which modules ship what.
        ...selectedModules.flatMap((projectModule) =>
          MODULE_COPY_TREES.map((copyTree) => ({
            type: COPY_MODULE_SOURCE,
            moduleName: projectModule.name,
            copyTreeDirectoryName: copyTree.directoryName,
            destinationDirectory: copyDestinations[copyTree.landsIn],
          })),
        ),

        {
          type: WRITE_PACKAGE_JSON,
          projectName: answers.projectName,
          projectStructure: answers.projectStructure,
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
        // `path` is absolute, which plop resolves as-is. `templateFile` is relative to this plopfile.
        //
        // A template's own `data` is merged OVER the shared data, so a module emitting one template
        // several times can vary it — the workspace layout does exactly that, one `package.json` per
        // package from one `.hbs`. Last-write-wins is deliberate and needs no conflict detection here:
        // the override is scoped to a single template, so there is no second contributor to disagree
        // with. See `RenderedTemplate.data`.
        ...selectedModules.flatMap((projectModule) =>
          (projectModule.renderedTemplates?.(answers) ?? []).map((template) => ({
            type: 'add',
            path: path.join(destinationDirectory, template.outputPath),
            templateFile: template.templateFile,
            data: { ...templateData, ...template.data },
          })),
        ),
      ]
    },
  })
}
