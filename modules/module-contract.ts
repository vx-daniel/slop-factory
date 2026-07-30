/**
 * The contract every generator module implements.
 *
 * A module contributes to a generated project through exactly TWO channels, and the split is
 * load-bearing rather than stylistic:
 *
 *   1. `<module>/source/` — copied VERBATIM, byte for byte, never rendered.
 *   2. `packageJsonFragment()` — merged into the generated package.json.
 *
 * WHY THE SOURCE TREE IS NEVER RENDERED. Handlebars and GitHub Actions both claim `{{ }}`.
 * `modules/node/source/.github/workflows/ci.yml` contains `${{ github.ref }}`; run that through
 * Handlebars and `{{ github.ref }}` resolves against the answers object, finds nothing, and emits an
 * empty string — leaving a bare `$` and a silently broken workflow that installs and typechecks
 * fine, then fails only in CI. So the copy channel does no template evaluation at all. Anything
 * needing interpolation goes through `packageJsonFragment()` or a `.hbs` template handled explicitly
 * by the generator, never through `source/`.
 *
 * Because the copy is UNIFORM across every module, the generator performs it — a module does not
 * declare it. `source/` mirrors its own output layout exactly, so `gate/source/scripts/gate.ts`
 * lands at `scripts/gate.ts` in the generated project. That convention is the whole mapping: to know
 * where a file ends up, read its path under `source/`.
 */

/** The runtimes a generated project can target. Selected by the `projectRuntime` prompt. */
export const PROJECT_RUNTIMES = ['node', 'bun'] as const
export type ProjectRuntime = (typeof PROJECT_RUNTIMES)[number]

/**
 * The test runners a generated project can use.
 *
 * Only meaningful under Bun — `bun test` does not exist for Node, so a Node project is always
 * `vitest`. The generator forces that rather than asking, because a question with one possible answer
 * is noise.
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
  readonly projectRuntime: ProjectRuntime
  /** Always `vitest` when `projectRuntime` is `node`, since `bun test` needs Bun. */
  readonly testRunner: TestRunner
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
export const MERGEABLE_PACKAGE_JSON_SECTIONS = [
  'scripts',
  'dependencies',
  'devDependencies',
  'engines',
] as const
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
}

/**
 * How a `.ts` file is executed under the selected runtime.
 *
 * Node cannot run this blueprint's TypeScript directly: Node's resolver does not read tsconfig
 * `paths`, so the first `@/*` import throws ERR_MODULE_NOT_FOUND. tsx supplies that resolution,
 * which is why the prefix is `node --import tsx` and not bare `node`. Bun runs `.ts` and resolves
 * tsconfig `paths` natively, so it needs no loader.
 *
 * Shared here because both the gate module (`check:all`) and the runtime modules (`coverage`) build
 * script commands from it, and a second copy of this string is a drift waiting to happen.
 */
export function typescriptRunnerPrefix(runtime: ProjectRuntime): string {
  return runtime === 'bun' ? 'bun' : 'node --import tsx'
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
}): string {
  const { projectName, merged } = options

  const packageJson: Record<string, unknown> = {
    name: projectName,
    version: '0.1.0',
    // Generated projects are private by default. Publishing is an explicit decision with real
    // consequences (a name claimed on the registry); defaulting to it would make accidental
    // publication the easy path.
    private: true,
    type: 'module',
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
