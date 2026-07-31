/**
 * The contract every generator module implements.
 *
 * A module contributes through five channels. The first three are files; the last two are merged data:
 *
 *   1. `<module>/source/` — copied VERBATIM to the PROJECT root, byte for byte, never rendered.
 *   2. `<module>/packageSource/` — copied VERBATIM to the PACKAGE root. See `MODULE_COPY_TREES`.
 *   3. `renderedTemplates()` — `.hbs` files run through Handlebars, output path included.
 *   4. `packageJsonFragment()` — merged into the generated package.json.
 *   5. `templateData()` — merged into the data every rendered template sees.
 *
 * The verbatim/rendered split in 1–2 vs 3 is load-bearing rather than stylistic.
 *
 * WHY THE SOURCE TREE IS NEVER RENDERED. Handlebars and GitHub Actions both claim `{{ }}`. A workflow
 * containing `${{ github.ref }}` run through
 * Handlebars and `{{ github.ref }}` resolves against the answers object, finds nothing, and emits an
 * empty string — leaving a bare `$` and a silently broken workflow that installs and typechecks
 * fine, then fails only in CI. So the copy channel does no template evaluation at all. Anything
 * needing interpolation goes through `packageJsonFragment()` or a `.hbs` template handled explicitly
 * by the generator, never through `source/`.
 *
 * Because the copy is UNIFORM across every module, the generator performs it — a module does not
 * declare it. Each copy tree mirrors its own output layout exactly, so `gate/source/scripts/gate.ts`
 * lands at `scripts/gate.ts` in the generated project. That convention is the whole mapping: to know
 * where a file ends up, read its path under the tree, then read which root that tree lands in.
 */

/**
 * Which root a copy tree's contents land in.
 *
 * `projectRoot` is the generated project's top directory. `packageRoot` is the directory holding the
 * package's own source — which under the single-package layout IS the project root, and under a
 * workspace layout would be `packages/<name>/`.
 */
export type ModuleCopyDestination = 'projectRoot' | 'packageRoot'

/** One verbatim-copy tree a module may ship, and which root its contents land in. */
export interface ModuleCopyTree {
  /** Directory name directly under `modules/<name>/`. */
  readonly directoryName: string
  readonly landsIn: ModuleCopyDestination
}

/**
 * Every verbatim-copy tree a module may ship. THE single list — nine things derive from it.
 *
 * WHY TWO TREES RATHER THAN ONE. A module's files do not all belong at the same level. The config
 * module is the clear case: `config.defaults.toml`, `.env.example` and `docs/configuration.md` belong at
 * the REPOSITORY root under any layout, while `src/config/**` is the package's own source and belongs
 * wherever that package's source lives. One copy tree writes to fixed paths, so it cannot express that
 * split — which is precisely what blocked the monorepo module.
 *
 * WHY THIS IS A NO-OP TODAY, AND WHY THAT IS THE POINT. Only the single-package layout exists, where
 * the package root and the project root are the same directory. So splitting a module's tree in two
 * changes nothing about generated output — and `examples:check` proves that byte-for-byte. Establishing
 * the channel while it is provably inert is much cheaper than establishing it inside the feature that
 * first needs it, where a drift could be the channel or could be the feature.
 *
 * WHY NOT RUN THE `.ts` FILES THROUGH HANDLEBARS INSTEAD. That was the considered alternative: make
 * `src/config/*.ts` into `.hbs` templates with a dynamic output path, which the rendered channel already
 * supports. Rejected because it would run real TypeScript through a template engine purely to vary a
 * directory prefix, and any future `{{` in that code — a template literal, a generic in an unlucky
 * position — would silently corrupt it. That is the exact hazard the copy/render split exists to
 * prevent, and the reason no copy tree is ever rendered.
 *
 * ADDING A THIRD TREE means adding it here and nowhere else in code — but the three JSON configs that
 * cannot import this constant (`tsconfig.json`, `tsconfig.build.json`, `biome.jsonc`) must be updated
 * by hand. `module-sources.test.ts` fails if you forget, which is the only reason that is safe.
 */
export const MODULE_COPY_TREES: readonly ModuleCopyTree[] = [
  { directoryName: 'source', landsIn: 'projectRoot' },
  { directoryName: 'packageSource', landsIn: 'packageRoot' },
]

/** Just the directory names, for the consumers that scan or glob rather than copy. */
export const MODULE_COPY_TREE_DIRECTORY_NAMES: readonly string[] = MODULE_COPY_TREES.map(
  (copyTree) => copyTree.directoryName,
)

/**
 * The package managers a generated project can use. Selected by the `packageManager` prompt.
 *
 * THIS IS ONE AXIS, NOT TWO. The manager also determines the runtime, because the two are not
 * independent in any combination worth shipping:
 *
 *   npm  → Node, `.ts` executed through tsx, `package-lock.json` committed
 *   pnpm → Node, `.ts` executed through tsx, `pnpm-lock.yaml` committed
 *   bun  → Bun, `.ts` executed natively (no loader), `bun.lock` committed
 *
 * Modelling manager and runtime as separate axes would produce a 3×2 grid whose exotic cells — Bun as
 * a package manager for a Node-executed project, pnpm installing for a Bun runtime — nobody asked for
 * and none of which the factory could claim to have verified. Deriving the runtime keeps the prompt to
 * one question and the generation matrix to a size CI can actually install and gate.
 *
 * The trade is real: if someone wants `bun install` with the Node runtime, this does not offer it.
 * That is a deliberate narrowing, not an oversight.
 *
 * yarn is deliberately absent. The generated gate's `detectPackageManager()` recognises it, so a
 * project can be migrated by hand, but the generator does not produce or verify that combination.
 */
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'bun'] as const
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]

/** Whether a manager implies the Bun runtime — the one place that mapping is written down. */
export function isBunRuntime(packageManager: PackageManager): boolean {
  return packageManager === 'bun'
}

/**
 * The layouts a generated project can have.
 *
 * `single` puts the package's source at the project root — `src/**` beside `package.json`. `monorepo`
 * puts it under `packages/<name>/`, with the root becoming a workspace root that holds no source of its
 * own.
 *
 * NOT YET REACHABLE FROM THE PROMPT, deliberately. The plumbing that resolves the package root and
 * writes the `workspaces` field lands before the per-module changes that make a generated workspace
 * actually build — its tsconfig `paths` and test-discovery globs still assume `single`. Offering an
 * option that produces a subtly broken project is worse than not offering it, so `toProjectAnswers`
 * forces `single` until those land. The `monorepo` path is exercised by tests, which supply the answer
 * directly, and that is what keeps this plumbing honest rather than merely unused.
 */
export const PROJECT_STRUCTURES = ['single', 'monorepo'] as const
export type ProjectStructure = (typeof PROJECT_STRUCTURES)[number]

/** The layout every generated project uses today — see `PROJECT_STRUCTURES`. */
export const DEFAULT_PROJECT_STRUCTURE: ProjectStructure = 'single'

/**
 * The package a generated monorepo starts with.
 *
 * `core` rather than the project's own name: a workspace whose first package is named after the repo
 * invites `packages/my-app/` inside `my-app/`, and the second package then has no natural name. `core`
 * says what the package IS — the thing the others depend on.
 */
export const DEFAULT_FIRST_PACKAGE_NAME = 'core'

/**
 * The workspace directory a monorepo's packages live under, and the glob that matches them.
 *
 * One constant rather than two literals because the directory name appears in three unrelated places —
 * the `workspaces` glob, the package root path, and the test-discovery scope — and a disagreement
 * between them fails in a way that names the glob rather than the mismatch.
 */
export const WORKSPACE_PACKAGES_DIRECTORY = 'packages'

/**
 * Where a package's own source lands, relative to the project root.
 *
 * Returns `.` for `single`, because the package root and the project root are the same directory there —
 * which is what made the `packageSource/` copy channel a provable no-op when it was introduced.
 */
export function packageRootRelativePath(answers: {
  readonly projectStructure: ProjectStructure
  readonly firstPackageName: string
}): string {
  if (answers.projectStructure === 'single') {
    return '.'
  }
  return `${WORKSPACE_PACKAGES_DIRECTORY}/${answers.firstPackageName}`
}

/**
 * The path vocabulary every prose template interpolates instead of hardcoding `src/`.
 *
 * WHY THIS EXISTS. `CLAUDE.md` and `README.md` are written FOR the reader of a generated project, and both
 * tell that reader where things are — where the config module lives, what the import alias maps to, what
 * coverage measures. Under a workspace every one of those answers changes.
 *
 * Found the hard way: the monorepo layout shipped with both documents still saying `@/*` → `src/*` and
 * pointing at `src/config/config.ts`. The project worked; its own documentation directed an agent to paths
 * that did not exist, which is worse than no documentation because it reads as authoritative.
 *
 * Returning the strings rather than a boolean keeps the templates readable — `{{sourceDirectory}}` in
 * prose, instead of an `{{#if isMonorepo}}` around every sentence that mentions a path. Nine references
 * across the two documents was the count that made that decision obvious.
 */
export function pathVocabulary(answers: {
  readonly projectStructure: ProjectStructure
  readonly firstPackageName: string
}): Readonly<Record<string, string>> {
  const isMonorepoLayout = answers.projectStructure === 'monorepo'
  const sourceDirectory = isMonorepoLayout ? `${WORKSPACE_PACKAGES_DIRECTORY}/${answers.firstPackageName}/src` : 'src'

  return {
    /** Where the package's source lives, relative to the project root. */
    sourceDirectory,
    /** The alias pattern as it appears in tsconfig `paths`, e.g. `@/*` or `@core/*`. */
    importAliasPattern: isMonorepoLayout ? `@${answers.firstPackageName}/*` : '@/*',
    /** What that pattern resolves to, written as it appears in tsconfig. */
    importAliasTarget: `./${sourceDirectory}/*`,
    /** An example aliased import, for prose that shows one. */
    exampleAliasedImport: isMonorepoLayout ? `@${answers.firstPackageName}/orders/store.js` : '@/orders/store.js',
    /** The glob coverage measures, matching what the runner config actually sets. */
    coverageSourceGlob: isMonorepoLayout ? `${WORKSPACE_PACKAGES_DIRECTORY}/*/src/**/*.ts` : 'src/**/*.ts',
  }
}

/**
 * The test runners a generated project can use.
 *
 * Only meaningful when the manager is `bun` — `bun test` ships with the Bun runtime and does not exist
 * for Node, so an npm or pnpm project is always `vitest`. The generator forces that rather than asking,
 * because a question with one possible answer is noise.
 */
export const TEST_RUNNERS = ['vitest', 'bun-test'] as const
export type TestRunner = (typeof TEST_RUNNERS)[number]

/**
 * The default, and the recommended answer under Bun.
 *
 * `bun test` genuinely works — it runs Vitest-API tests unmodified (Bun maps the `vitest` import to
 * its own API) and fails correctly on mutated code. Vitest is still the default because of COVERAGE,
 * and the gap is concrete rather than a matter of taste:
 *
 *   - Bun reports only `% Funcs` and `% Lines` — no branch or statement coverage. It also measures only
 *     files a test imports, with no equivalent of Vitest's `coverage.include`, so an entirely untested
 *     module is absent from the report rather than counted as 0% and the total still reads 100%.
 *   - Bun offers no `json-summary` reporter, so `COVERAGE.md` cannot be generated without rewriting
 *     the script to parse lcov.
 *   - Bun has no `passWithNoTests` equivalent: zero test files is a hard exit 1.
 *
 * None of that makes `bun test` wrong — it makes it a trade, which is why it is offered and why the
 * consequences travel with it in the generated documentation.
 */
export const DEFAULT_TEST_RUNNER: TestRunner = 'vitest'

/**
 * The answers collected by the generator's prompts, after normalization.
 *
 * `projectPath` is ABSOLUTE — the file-tree-selection prompt returns an absolute path, and it is
 * deliberately never joined under the factory's own directory. Doing so was the original bug: the
 * generator wrote into `slop-factory/src/...`, generating into itself.
 */
export interface ProjectAnswers {
  readonly projectName: string
  readonly projectPath: string
  readonly packageManager: PackageManager
  /** Always `vitest` unless `packageManager` is `bun`, since `bun test` ships with the Bun runtime. */
  readonly testRunner: TestRunner
  /** Always `single` today — the prompt is deliberately not offered yet. See `PROJECT_STRUCTURES`. */
  readonly projectStructure: ProjectStructure
  /**
   * The one package a generated monorepo starts with, e.g. `core`.
   *
   * Carried even under `single`, where it is unused, rather than made optional. An optional field would
   * push a `?? 'core'` fallback into every consumer that builds a package path, and the consumer that
   * forgot it would silently emit `packages/undefined/`.
   */
  readonly firstPackageName: string
  /** Values of the opt-in feature checkboxes, e.g. `['config']`. */
  readonly enableFeatures: readonly string[]
}

/**
 * One module's contribution to the generated package.json.
 *
 * Only these sections may be contributed. Project IDENTITY (`name`, `description`, `version`,
 * `type`, `private`) is owned by the generator, not by any module — a module has no business naming
 * the project. `engines` is contributable because it genuinely varies by runtime: Node needs
 * `>=24` for native type-stripping, Bun does not use the field the same way.
 */
export interface PackageJsonFragment {
  readonly scripts?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly engines?: Readonly<Record<string, string>>
}

/** The package.json sections a module may contribute to, in the order they are merged. */
export const MERGEABLE_PACKAGE_JSON_SECTIONS = ['scripts', 'dependencies', 'devDependencies', 'engines'] as const
export type MergeablePackageJsonSection = (typeof MERGEABLE_PACKAGE_JSON_SECTIONS)[number]

/**
 * Where a module's documentation lands in the generated project, and how the docs index describes it.
 *
 * Every module MUST document itself. The reasoning is the same one that makes the generated CLAUDE.md
 * a rendered template rather than a copied file: a project assembled from parts, whose parts are not
 * explained, forces the next reader to reverse-engineer why Biome is pinned exactly or why a file
 * named `*.io.ts` is exempt from coverage. The answers exist — they just have to travel with the code.
 *
 * `path` is declared here rather than inferred from the module name because the FILENAME should read
 * naturally to someone working in the generated project, where "base" and "gate" are factory-internal
 * words. Declaring it keeps the module→doc mapping explicit and checkable while letting the file be
 * called `testing.md`.
 */
export interface ModuleDocumentation {
  /** Path within the generated project. Must start with `docs/`. */
  readonly path: string
  /** Heading for this module's row in the docs index. */
  readonly title: string
  /** One-line description for the docs index table. */
  readonly summary: string
}

export interface ProjectModule {
  /** Directory name under `modules/`. Also the name reported in conflict errors. */
  readonly name: string

  /**
   * This module's documentation. The file itself lives under the module's `source/docs/` directory so
   * the ordinary verbatim copy delivers it — no separate channel, and it is present exactly when the
   * module is selected.
   */
  readonly documentation: ModuleDocumentation

  /**
   * Whether this module applies to the given answers. A module that returns false is skipped
   * entirely: its `source/` tree is not copied and its fragment is not merged.
   */
  isSelected(answers: ProjectAnswers): boolean

  /** This module's package.json contribution. Called only when `isSelected` returned true. */
  packageJsonFragment(answers: ProjectAnswers): PackageJsonFragment

  /**
   * Files this module renders through Handlebars, as opposed to copying verbatim from `source/`.
   *
   * Declared here rather than listed in the generator, so the generator knows nothing about any
   * module's files. The five base templates were previously five near-identical `add` blocks inside
   * `plopfile.ts` — which both duplicated the shape and meant only `base` could contribute a rendered
   * file at all.
   */
  renderedTemplates?(answers: ProjectAnswers): readonly RenderedTemplate[]

  /**
   * This module's contribution to the data every rendered template sees.
   *
   * Merged across all selected modules, so a flag lives with the module that knows about it: the
   * `vitest` module contributes `usesVitest`, the runtime modules contribute the package-manager
   * commands, `config` contributes `hasConfigModule`. Previously all of these were assembled centrally,
   * which is how the generator ended up branching on the runtime it has no business knowing about.
   *
   * An UNSELECTED module contributes nothing, and a missing key is falsy in Handlebars — which is
   * exactly the wanted semantics. `{{#if usesVitest}}` is false when the vitest module is absent,
   * without anyone having to remember to pass `false`.
   */
  templateData?(answers: ProjectAnswers): Readonly<Record<string, unknown>>
}

/** One Handlebars template and where its output lands in the generated project. */
export interface RenderedTemplate {
  /** Path to the `.hbs` file, relative to the factory root (where the plopfile lives). */
  readonly templateFile: string
  /**
   * Destination path relative to the generated project root.
   *
   * MAY contain Handlebars expressions — plop renders the output path as well as the contents
   * (`node-plop/src/actions/_common-action-utils.js`, `makeDestPath`). Verified: a path of
   * `packages/{{firstPackageName}}/package.json` creates the directory under the rendered name. That is
   * what lets a module emit into a directory whose name is an answer, which a verbatim copy cannot do.
   */
  readonly outputPath: string
}

/**
 * Merges the selected modules' template-data contributions into the single object every template sees.
 *
 * Conflicts THROW, for the same reason `mergePackageJsonFragments` does: two modules disagreeing about
 * a flag means the rendered output depends on registry order, and the resulting wrong document would
 * look deliberate. An identical value contributed twice is fine.
 */
export function mergeTemplateData(
  contributions: ReadonlyArray<{ moduleName: string; data: Readonly<Record<string, unknown>> }>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  const contributingModule: Record<string, string> = {}

  for (const { moduleName, data } of contributions) {
    for (const [key, value] of Object.entries(data)) {
      const existingValue = merged[key]
      if (key in merged && existingValue !== value) {
        throw new Error(
          `template data conflict: "${key}" is set to ${JSON.stringify(existingValue)} by module ` +
            `"${contributingModule[key]}" and to ${JSON.stringify(value)} by module "${moduleName}". ` +
            'Two modules cannot disagree about the same template flag — give it a single owner.',
        )
      }
      merged[key] = value
      contributingModule[key] = moduleName
    }
  }

  return merged
}

/**
 * How a `.ts` file is executed, given the selected package manager.
 *
 * Node cannot run this blueprint's TypeScript directly: Node's resolver does not read tsconfig
 * `paths`, so the first `@/*` import throws ERR_MODULE_NOT_FOUND. tsx supplies that resolution,
 * which is why the prefix is `node --import tsx` and not bare `node`. Bun runs `.ts` and resolves
 * tsconfig `paths` natively, so it needs no loader.
 *
 * Takes the MANAGER rather than a runtime because the manager is the axis the operator chooses; the
 * runtime follows from it (see `PACKAGE_MANAGERS`). npm and pnpm both mean Node, so both get tsx.
 *
 * Shared here because the gate module (`check:all`) and the vitest module (`coverage`) both build
 * script commands from it, and a second copy of this string is a drift waiting to happen.
 */
export function typescriptRunnerPrefix(packageManager: PackageManager): string {
  return isBunRuntime(packageManager) ? 'bun' : 'node --import tsx'
}

/**
 * Merges module fragments into one package.json section set, in module order.
 *
 * Conflicts THROW rather than last-write-wins. Two modules claiming the same script name (or
 * pinning the same dependency to different versions) is a factory bug: silently picking one would
 * ship a project whose gate runs something its author did not choose, and the symptom would surface
 * far from the cause. Naming both modules and the key here turns that into an immediate, locatable
 * failure.
 *
 * An identical value contributed twice is NOT a conflict — two modules may legitimately both need
 * `typescript` at the same version, and forcing an artificial owner for a shared pin would be
 * bookkeeping with no benefit.
 */
export function mergePackageJsonFragments(
  fragments: ReadonlyArray<{ moduleName: string; fragment: PackageJsonFragment }>,
): PackageJsonFragment {
  const merged: Record<MergeablePackageJsonSection, Record<string, string>> = {
    scripts: {},
    dependencies: {},
    devDependencies: {},
    engines: {},
  }
  /** Which module contributed each key, per section — the provenance a conflict message needs. */
  const contributingModule: Record<MergeablePackageJsonSection, Record<string, string>> = {
    scripts: {},
    dependencies: {},
    devDependencies: {},
    engines: {},
  }

  for (const { moduleName, fragment } of fragments) {
    for (const section of MERGEABLE_PACKAGE_JSON_SECTIONS) {
      const contributed = fragment[section]
      if (contributed === undefined) {
        continue
      }
      for (const [key, value] of Object.entries(contributed)) {
        const existingValue = merged[section][key]
        if (existingValue !== undefined && existingValue !== value) {
          const previousModule = contributingModule[section][key]
          throw new Error(
            `package.json conflict in "${section}": key "${key}" is set to "${existingValue}" by ` +
              `module "${previousModule}" and to "${value}" by module "${moduleName}". ` +
              'Two modules cannot own the same key with different values — give it a single owner.',
          )
        }
        merged[section][key] = value
        contributingModule[section][key] = moduleName
      }
    }
  }

  return merged
}

/**
 * Renders the final package.json text.
 *
 * Identity comes first so a reader opening the file sees what the project IS before how it is
 * built. Empty sections are omitted entirely rather than emitted as `{}` — an empty
 * `"dependencies": {}` reads as "considered and found to need none", which is a claim the generator
 * cannot make. Keys within each section are sorted, so regenerating with the same answers produces
 * a byte-identical file and a diff shows only real changes.
 */
export function renderPackageJson(options: {
  readonly projectName: string
  readonly merged: PackageJsonFragment
  /** Omitted means `single`, which adds no `workspaces` field at all. */
  readonly projectStructure?: ProjectStructure
}): string {
  const { projectName, merged, projectStructure = DEFAULT_PROJECT_STRUCTURE } = options

  const packageJson: Record<string, unknown> = {
    name: projectName,
    version: '0.1.0',
    // Generated projects are private by default. Publishing is an explicit decision with real
    // consequences (a name claimed on the registry); defaulting to it would make accidental
    // publication the easy path.
    private: true,
    type: 'module',
  }

  /**
   * `workspaces` is written HERE, not contributed by a module, for two reasons.
   *
   * The typed one: it is a string ARRAY, and every part of `mergePackageJsonFragments` — the merge loop,
   * the conflict message, the provenance map, the key sort — is `Record<string, string>`. Adding an array
   * section would break that invariant in four places to serve one field with one possible value.
   *
   * The conceptual one: "is this a workspace root" is structural IDENTITY, which this function already
   * owns alongside `name`, `private` and `type` — and which the contract explicitly says is not a
   * module's business. No module other than `monorepo` would ever add a workspace glob.
   *
   * Placed directly after the identity block so a reader sees WHAT the project is before how it builds.
   */
  if (projectStructure === 'monorepo') {
    packageJson.workspaces = [`${WORKSPACE_PACKAGES_DIRECTORY}/*`]
  }

  for (const section of MERGEABLE_PACKAGE_JSON_SECTIONS) {
    const entries = Object.entries(merged[section] ?? {})
    if (entries.length === 0) {
      continue
    }
    entries.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    packageJson[section] = Object.fromEntries(entries)
  }

  return `${JSON.stringify(packageJson, null, 2)}\n`
}
