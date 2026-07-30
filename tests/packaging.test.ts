import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { PROJECT_MODULES } from '../modules/registry.js'
import {
  isBunRuntime,
  PACKAGE_MANAGERS,
  TEST_RUNNERS,
  type ProjectAnswers,
} from '../modules/module-contract.js'

/**
 * Asserts the PUBLISHED artifact is complete — the tarball `npm publish` would upload.
 *
 * This is a separate concern from whether generation works, and it fails in a way nothing else catches:
 * every other test in this repo runs against the working tree, where every file is present by
 * definition. A `files` entry omitted from package.json, or an ignore rule swallowing a template,
 * produces a package that installs cleanly and then fails at the first `npx slop-factory generate` —
 * for the consumer, not for us.
 *
 * Two mechanisms make that a live risk rather than a theoretical one:
 *
 *   1. `files` is an ALLOWLIST. Anything not named is absent, so adding a module asset type without
 *      updating the build's copy step ships a package missing it.
 *   2. npm honours `.gitignore` / `.npmignore` files ANYWHERE in the package as pack filters.
 *
 * It builds first, because `files` names `dist/` and an unbuilt tree would fail for the wrong reason.
 */

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')

/** Files that must be in the tarball regardless of which modules exist. */
const REQUIRED_ENTRY_POINTS = [
  'package.json',
  'bin/slop-factory.mjs',
  'dist/cli.js',
  'dist/plopfile.js',
  'dist/plopfile-path.js',
]

/**
 * Assets that are dotfiles or dot-directories, listed explicitly because they are the ones most likely
 * to be silently dropped — npm's handling of dot-paths is where packaging surprises concentrate.
 */
const REQUIRED_DOT_PATH_ASSETS = [
  'dist/modules/base/source/.githooks/pre-commit',
  'dist/modules/base/source/.claude/rules/naming-and-style.md',
  'dist/modules/base/source/.github/workflows/secret-scan.yml',
  'dist/modules/gate/source/.biome/naming.grit',
  'dist/modules/config/source/.env.example',
]

/** Source files that must NEVER ship: they import devDependencies or are the uncompiled originals. */
/**
 * Path prefixes that must never appear in the tarball.
 *
 * `tests/` and `scripts/` import devDependencies; `modules/`, `cli.ts`, and `plopfile.ts` are the
 * uncompiled originals that `dist/` supersedes. `examples/` is two full generated projects — ~114 files
 * of pure review surface with no runtime purpose, which would roughly triple the published size.
 *
 * All are already excluded by the `files` allowlist. This asserts it stays that way: `files` is an
 * allowlist, so a future entry added carelessly (`"."`, or a broad glob) would pull them all in at once.
 */
const FORBIDDEN_PATH_PREFIXES = [
  'tests/',
  'scripts/',
  'modules/',
  'examples/',
  'cli.ts',
  'plopfile.ts',
]

/**
 * Every answer combination the prompts can reach.
 *
 * `bun-test` is excluded for npm and pnpm because `bun test` ships with the Bun runtime and the prompt is
 * skipped there — so those combinations are unreachable and asserting against them would describe a
 * generator that does not exist.
 */
const REACHABLE_ANSWERS: readonly ProjectAnswers[] = PACKAGE_MANAGERS.flatMap((packageManager) =>
  TEST_RUNNERS.filter(
    (testRunner) => testRunner === 'vitest' || isBunRuntime(packageManager),
  ).map((testRunner) => ({
    projectName: 'irrelevant',
    projectPath: '/tmp',
    packageManager,
    testRunner,
    enableFeatures: ['config'],
  })),
)

/**
 * Every `.hbs` file any module can declare, across every reachable answer combination.
 *
 * DERIVED rather than listed, and that is the point. This was a hardcoded array of five base-module
 * filenames, which made the test's own name ("every rendered template") false the moment a template was
 * added: `base/ci.yml.hbs` and `vitest/coverage-main.yml.hbs` were both absent from it, and the hardcoded
 * `dist/modules/base/` prefix meant a non-base module's template could not have been checked even if
 * someone had remembered to add it.
 *
 * The union across combinations matters because a module may decline to emit a template for some
 * answers — `vitest` returns none under Bun — so no single combination sees them all.
 */
function everyDeclaredTemplateFile(): string[] {
  const templateFiles = new Set<string>()

  for (const answers of REACHABLE_ANSWERS) {
    for (const projectModule of PROJECT_MODULES) {
      if (!projectModule.isSelected(answers)) {
        continue
      }
      for (const template of projectModule.renderedTemplates?.(answers) ?? []) {
        templateFiles.add(template.templateFile)
      }
    }
  }

  return [...templateFiles].sort()
}

let packedPaths: string[]

beforeAll(() => {
  // Setup failures THROW rather than assert. A broken precondition is not a failed claim about the
  // system under test — it means the test never ran. Throwing aborts the suite once with the command's
  // output, where an assertion here would report as a mysterious failure attributed to a hook.
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: FACTORY_ROOT,
    encoding: 'utf8',
  })
  if (build.status !== 0) {
    throw new Error(`build failed:\n${build.stdout}${build.stderr}`)
  }

  // `--dry-run` computes the file list without writing a tarball, so the test leaves nothing behind.
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: FACTORY_ROOT,
    encoding: 'utf8',
  })
  if (pack.status !== 0) {
    throw new Error(`npm pack failed:\n${pack.stderr}`)
  }

  const packResult = JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>
  packedPaths = packResult[0].files.map((file) => file.path)
}, 300_000)

describe('published tarball', () => {
  it('includes the CLI entry points', () => {
    for (const requiredPath of REQUIRED_ENTRY_POINTS) {
      expect(packedPaths, `${requiredPath} missing from the tarball`).toContain(requiredPath)
    }
  })

  it('includes every module compiled descriptor and its documentation', () => {
    for (const projectModule of PROJECT_MODULES) {
      expect(packedPaths, `${projectModule.name}/module.js missing`).toContain(
        `dist/modules/${projectModule.name}/module.js`,
      )
      expect(packedPaths, `${projectModule.name} documentation missing`).toContain(
        `dist/modules/${projectModule.name}/source/${projectModule.documentation.path}`,
      )
    }
  })

  it('includes the dot-path assets npm is most likely to drop', () => {
    for (const requiredPath of REQUIRED_DOT_PATH_ASSETS) {
      expect(packedPaths, `${requiredPath} missing from the tarball`).toContain(requiredPath)
    }
  })

  it('includes every rendered template the generator adds', () => {
    // These are resolved by `templateFile` at generation time, so a missing one fails only when a
    // consumer runs the tool — the exact failure this suite exists to move earlier.
    //
    // `templateFile` is relative to the plopfile's directory, and the published plopfile is
    // `dist/plopfile.js`, so the packed path is the declared path under `dist/`. Asserting that exact
    // string is what ties the two halves together: the copier could place a template somewhere real and
    // the generator would still fail to resolve it.
    const declaredTemplateFiles = everyDeclaredTemplateFile()

    // Guards the derivation itself. If a refactor made `renderedTemplates` return nothing, every
    // assertion below would vacuously pass and the test would report green on an empty package.
    expect(declaredTemplateFiles.length, 'no module declares any rendered template').toBeGreaterThan(0)

    for (const templateFile of declaredTemplateFiles) {
      expect(packedPaths, `${templateFile} missing from the tarball`).toContain(
        `dist/${templateFile}`,
      )
    }
  })

  it('ships no uncompiled source or test files', () => {
    const leaked = packedPaths.filter((packedPath) =>
      FORBIDDEN_PATH_PREFIXES.some((prefix) => packedPath.startsWith(prefix)),
    )

    expect(
      leaked,
      'these import devDependencies or are the uncompiled originals; shipping them puts ' +
        'unresolvable imports inside the package',
    ).toEqual([])
  })

  it('declares a bin that points at a packed file', () => {
    // A `bin` path excluded by `files` installs a broken symlink: `npx slop-factory` then fails with
    // ENOENT rather than anything that names the cause.
    const manifest = packedPaths.includes('package.json')
    expect(manifest).toBe(true)

    const binaryPath = 'bin/slop-factory.mjs'
    expect(packedPaths, 'the declared bin is not in the tarball').toContain(binaryPath)
  })
})
