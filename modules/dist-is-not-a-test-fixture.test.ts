import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards that no test suite builds, because `dist/` is shared mutable state between Vitest projects.
 *
 * WHY THIS EXISTS. Nearly every project in `vitest.config.ts` reads `dist/plopfile.js` or `dist/cli.js`,
 * and Vitest runs projects CONCURRENTLY. `npm run build` begins by DELETING `dist/`. So a suite that built
 * in a hook was wiping the artifact its siblings were mid-way through reading — nondeterministically, and
 * reported against the READER every time. `packaging` did exactly that, and the error it produced named
 * `layout`. Two analysis cycles were lost to that misdirection before anyone read the config closely
 * enough (#23).
 *
 * The fix moved the build into `test:packaging`, where the four sibling scripts already had it. This guard
 * is what keeps it there: the arrangement was previously safe "by convention only", which is precisely the
 * kind of invariant that decays the moment someone adds a suite needing a fresh build.
 *
 * WHY IT ANCHORS ON THE CALLEE rather than on the words `npm run build`. Those words legitimately appear in
 * `tests/cli.test.ts`, both in prose and as the literal string an assertion expects, because the binary
 * prints that advice when `dist/` is missing. Searching for them would fail against correct code,
 * which is the trap `.claude/rules/asserting-on-file-content.md` documents. Naming the spawn function, or
 * the argument array only a real call produces, distinguishes an invocation from a mention. The patterns
 * themselves are listed below rather than counted here, so adding one does not falsify this paragraph.
 *
 * MUTATION-TESTED in both shapes: restoring `spawnSync('npm', ['run', 'build'], …)` to
 * `tests/packaging.test.ts` fails this test and names the file, and so does `execSync('npm run build')`.
 * Both were run, and the suite stayed green against `tests/cli.test.ts` as it stands — which is the false
 * positive the anchoring exists to avoid.
 */

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')
const TESTS_DIRECTORY = path.join(FACTORY_ROOT, 'tests')

/**
 * The shapes a build invocation takes in source.
 *
 * Each is ANCHORED ON THE CALLEE rather than on the command text, which is what keeps them off the
 * occurrences of `npm run build` in `tests/cli.test.ts` — where it appears in prose, and as the literal
 * string an assertion expects because the binary prints that advice. `toContain('npm run build')` names no
 * spawn function, so no pattern here reaches it. Review added the second shape after the first went in;
 * neither the list nor this paragraph states how many there are, so a third cannot falsify it.
 *
 * Whitespace-tolerant, because the formatter wraps long calls and a rigid string match would silently stop
 * guarding anything the first time one grew past the line limit.
 */
const BUILD_INVOCATION_PATTERNS = [
  // spawnSync('npm', ['run', 'build'], …) — an argument array.
  /'run',\s*'build'/,
  // execSync('npm run build') and friends — the command as one string, named by its caller.
  /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\(\s*['"`][^'"`]*npm\s+run\s+build/,
]

describe('dist is a precondition, not a fixture', () => {
  it('has no test suite that runs the build', async () => {
    const testFileNames = (await readdir(TESTS_DIRECTORY)).filter((fileName) => fileName.endsWith('.ts'))

    // Guards the guard: an empty or mis-resolved directory would iterate nothing and pass. The exact count
    // is deliberately not pinned — that would fail on every new test file for no reason — but zero is
    // always wrong.
    expect(testFileNames.length, 'no test files found — is TESTS_DIRECTORY still correct?').toBeGreaterThan(0)

    const buildingFiles: string[] = []
    for (const fileName of testFileNames) {
      const contents = await readFile(path.join(TESTS_DIRECTORY, fileName), 'utf8')
      if (BUILD_INVOCATION_PATTERNS.some((pattern) => pattern.test(contents))) {
        buildingFiles.push(fileName)
      }
    }

    expect(
      buildingFiles,
      'these suites run the build, which deletes dist/ while sibling projects are reading it. Put the ' +
        'build in the npm script instead, as every test:* script already does.',
    ).toEqual([])
  })
})
