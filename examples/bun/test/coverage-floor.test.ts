import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the coverage floor itself.
 *
 * TWO reasons this test exists, and neither is ceremony:
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
