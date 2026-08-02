import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards that no test suite builds, because `dist/` is shared mutable state between Vitest projects.
 *
 * WHY THIS EXISTS. Five of the six projects in `vitest.config.ts` read `dist/plopfile.js` or `dist/cli.js`,
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
 * WHY IT MATCHES THE ARGUMENT ARRAY rather than the words `npm run build`. Those words legitimately appear
 * in `tests/cli.test.ts` — twice in prose, and once as the literal string an assertion expects, because the
 * binary prints that advice when `dist/` is missing. Searching for them would fail against correct code,
 * which is the trap `.claude/rules/asserting-on-file-content.md` documents. Only a real invocation writes
 * the arguments as a quoted array, so that form distinguishes a call from a mention.
 *
 * MUTATION-TESTED: restoring `spawnSync('npm', ['run', 'build'], …)` to `tests/packaging.test.ts` fails
 * this test and names the file.
 */

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')
const TESTS_DIRECTORY = path.join(FACTORY_ROOT, 'tests')

/**
 * The argument array of a build invocation, as it appears in source.
 *
 * Whitespace-tolerant, because the formatter may wrap a long `spawnSync` call across lines and a literal
 * string match would then silently stop guarding anything.
 */
const BUILD_INVOCATION_PATTERN = /'run',\s*'build'/

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
      if (BUILD_INVOCATION_PATTERN.test(contents)) {
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
