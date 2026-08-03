import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the coverage floor, and the thing that makes the floor mean anything.
 *
 * Two halves. The first guards the threshold's EXISTENCE — see the reasons below. The second, further
 * down, guards its REACH: `bun test` measures only files a test imported, so before that half existed an
 * entirely untested module was absent from the coverage table rather than counted as zero, and the floor
 * passed at 100% while the module went unexercised. Read that block before touching it; its mechanism is
 * a deliberate side effect and it does not look like a test.
 *
 * TWO reasons the threshold half exists, and neither is ceremony:
 *
 * 1. **`bun test` has no `passWithNoTests`.** Zero test files is a hard exit 1 with no flag to soften
 *    it, so a freshly generated project with no source code would fail its own gate on day one. One
 *    real test is the honest fix — a `|| true` on the test script would silence genuine failures too.
 *
 * 2. **The floor is easy to disable silently.** Under `bun test` the threshold lives in `bunfig.toml`,
 *    a file nothing else reads. Deleting the line, or lowering it, produces no error anywhere — the
 *    suite just stops enforcing coverage while continuing to report success. This test turns that into
 *    a failure.
 *
 * It is deliberately NOT a placeholder to delete once real tests exist. Keep it: reason 2 stays true
 * for the life of the project. (You may delete it if you migrate to Vitest, where the floor lives in
 * `vitest.config.ts` and is enforced by the `coverage` script directly.)
 *
 * The `vitest` import resolves under `bun test` because Bun maps it to its own test API — which is
 * also why switching runners later needs no import rewrites.
 */

/** The floor this project committed to. Raising it here and in bunfig.toml must happen together. */
const EXPECTED_MINIMUM_THRESHOLD = 0.85

/**
 * Finds `bunfig.toml` by walking UP from this file, rather than a fixed number of levels.
 *
 * The hop count is not knowable here, because this file's depth depends on the project layout: `test/`
 * sits at the project root in a single-package project and at `packages/<name>/test/` in a workspace,
 * while `bunfig.toml` is always at the root. A hardcoded `dirname(import.meta.dirname)` worked for the
 * first and looked for `packages/<name>/bunfig.toml` in the second — measured, ENOENT.
 *
 * That failure was loud rather than silent, which is the only reason it was cheap. But a guard that
 * throws for a reason unrelated to what it guards is one impatient refactor away from being deleted as
 * broken, taking the coverage floor's only protection with it.
 *
 * Walking up is also how `src/config/config.ts` locates `config.defaults.toml`, so both agree about
 * where the repository root is.
 */
function findBunfigPath(startDirectory: string): string {
  let currentDirectory = startDirectory

  for (;;) {
    const candidatePath = resolve(currentDirectory, 'bunfig.toml')
    if (existsSync(candidatePath)) {
      return candidatePath
    }

    const parentDirectory = dirname(currentDirectory)
    // `dirname` of the filesystem root returns the root itself, which is the only stop condition.
    if (parentDirectory === currentDirectory) {
      throw new Error(
        `could not find bunfig.toml in any directory above ${startDirectory}. It holds the coverage ` +
          'floor this test guards; if it was deleted, restore it rather than deleting this test.',
      )
    }
    currentDirectory = parentDirectory
  }
}

const BUNFIG_PATH = findBunfigPath(import.meta.dirname)

/**
 * Reads `coverageThreshold` out of bunfig.toml.
 *
 * Parsed with a regex rather than a TOML library because this test must run with **no dependencies** —
 * the `bun-test` module deliberately contributes none, and adding `smol-toml` just to read one number
 * would make the test runner choice drag in a package the project may not otherwise want.
 */
function readCoverageThreshold(bunfigContents: string): number | undefined {
  const thresholdMatch = bunfigContents.match(/^\s*coverageThreshold\s*=\s*([0-9.]+)\s*$/m)
  if (thresholdMatch === null) {
    return undefined
  }
  return Number.parseFloat(thresholdMatch[1])
}

/** Whether bunfig.toml enables coverage collection unconditionally. */
function readCoverageEnabled(bunfigContents: string): boolean {
  return /^\s*coverage\s*=\s*true\s*$/m.test(bunfigContents)
}

describe('coverage floor configuration', () => {
  const bunfigContents = readFileSync(BUNFIG_PATH, 'utf8')

  it('declares a coverage threshold in bunfig.toml', () => {
    expect(
      readCoverageThreshold(bunfigContents),
      'bunfig.toml must declare `coverageThreshold` — without it the floor is silently disabled',
    ).toBeDefined()
  })

  it('keeps the threshold at or above the committed floor', () => {
    const threshold = readCoverageThreshold(bunfigContents) ?? 0

    expect(
      threshold,
      `coverage floor was lowered below ${EXPECTED_MINIMUM_THRESHOLD} — raise it back, or change ` +
        'EXPECTED_MINIMUM_THRESHOLD deliberately and say why in the commit',
    ).toBeGreaterThanOrEqual(EXPECTED_MINIMUM_THRESHOLD)
  })

  it('collects coverage on a bare `bun test`, not only with --coverage', () => {
    // The gate runs `bun test`. If coverage is not enabled in config, that run reports success on code
    // the floor would have rejected, and only the separate `coverage` script would catch it.
    expect(
      readCoverageEnabled(bunfigContents),
      'bunfig.toml must set `coverage = true` so the gate enforces the floor',
    ).toBe(true)
  })
})

/** The project root, derived once from the file the threshold lives in. */
const PROJECT_ROOT = dirname(BUNFIG_PATH)

/** Where source lives in a single-package project, relative to the root. */
const SINGLE_PACKAGE_SOURCE_DIRECTORY = 'src'
/** Where the workspace layout keeps its packages, each with its own source directory. */
const WORKSPACE_PACKAGES_DIRECTORY = 'packages'

/** Suffixes that are not measurable source: tests are excluded from coverage, declarations emit nothing. */
const NON_SOURCE_SUFFIXES = ['.test.ts', '.d.ts']

/** Generous, because this imports every module in the project; it exists to fail rather than hang. */
const IMPORT_EVERY_SOURCE_FILE_TIMEOUT_MS = 30_000

/**
 * The source directories coverage should account for, under either layout.
 *
 * BOTH LAYOUTS FROM ONE LIST rather than branching on a flag, because this file ships through
 * `packageSource/` and is copied VERBATIM — no Handlebars, so there is no `isMonorepo` to test. Probing
 * the filesystem is what is left, and it is also more honest: it reports what the project actually has.
 *
 * The workspace case scans EVERY package, not just the one this file sits in. Under a workspace layout
 * `packageSource/` lands in the first package only, so `../src` would cover that package and silently
 * ignore every other one — which is the same blindness this half exists to remove, one level up.
 */
function findSourceDirectories(): readonly string[] {
  const candidateDirectories = [join(PROJECT_ROOT, SINGLE_PACKAGE_SOURCE_DIRECTORY)]

  const packagesDirectory = join(PROJECT_ROOT, WORKSPACE_PACKAGES_DIRECTORY)
  if (existsSync(packagesDirectory)) {
    for (const packageEntry of readdirSync(packagesDirectory, { withFileTypes: true })) {
      if (packageEntry.isDirectory()) {
        candidateDirectories.push(join(packagesDirectory, packageEntry.name, SINGLE_PACKAGE_SOURCE_DIRECTORY))
      }
    }
  }

  return candidateDirectories.filter((directory) => existsSync(directory))
}

/** Every measurable `.ts` file beneath a directory, recursively. */
function findSourceFiles(sourceDirectory: string): readonly string[] {
  return readdirSync(sourceDirectory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(sourceDirectory, entry.name)
    if (entry.isDirectory()) {
      return findSourceFiles(entryPath)
    }
    if (!entry.name.endsWith('.ts') || NON_SOURCE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      return []
    }
    return [entryPath]
  })
}

describe('coverage floor reach', () => {
  it(
    'imports every source file, so an untested one counts as zero rather than vanishing',
    async () => {
      // THIS TEST WORKS BY SIDE EFFECT, which is why it needs explaining rather than tidying.
      //
      // `bun test` measures only files that were imported during the run. Vitest solves this with
      // `coverage.include`; Bun has no equivalent, so an untested module is absent from the table
      // ENTIRELY rather than reported as 0%, and the total is computed without it. Measured on Bun
      // 1.3.14: adding an untested `src/orphan.ts` left the total at 100.00 and the floor passed.
      //
      // Importing each file is what puts it in the denominator. With this test present the same orphan
      // appears at 0.00%, the total falls to 66.67, and `bun test` exits 1 — the floor does the
      // enforcing, which is why there is no coverage assertion here to find.
      //
      // CONSEQUENCE, because it is a real cost and not a footnote: importing a module EXECUTES its
      // top-level code. A module that opens a connection or reads required configuration at import time
      // will do so on every `bun test`. If that is untenable for a file, the fix is to move the side
      // effect into a function — which is worth doing anyway — not to weaken this test.
      const failedImports: string[] = []

      for (const sourceDirectory of findSourceDirectories()) {
        for (const sourceFilePath of findSourceFiles(sourceDirectory)) {
          try {
            await import(sourceFilePath)
          } catch (error) {
            // Collected with the PATH rather than rethrown bare. A module that throws at import would
            // otherwise fail this file with a stack trace pointing here, naming the harness instead of
            // the module — and the reader would look for a bug in the guard.
            failedImports.push(`${sourceFilePath}: ${String(error)}`)
          }
        }
      }

      // A project with no source yet is the NORMAL case immediately after generation, so an assertion
      // that some file was found would fail every new project on its first run — the same day-one
      // failure the threshold half of this file exists to avoid. Absence of source is not a defect.
      expect(failedImports, 'a source file could not be imported, so coverage cannot account for it').toEqual([])
    },
    IMPORT_EVERY_SOURCE_FILE_TIMEOUT_MS,
  )
})
