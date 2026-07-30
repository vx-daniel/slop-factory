#!/usr/bin/env node
/**
 * Regenerates the committed example projects under `examples/`, or checks them for drift.
 *
 * ```
 * npm run examples:refresh   # rewrite examples/ from the current modules
 * npm run examples:check     # generate to a temp dir and diff; non-zero on any difference
 * ```
 *
 * WHY COMMITTED EXAMPLES EXIST. Two things. They let the output be read without running the generator,
 * and — the bigger one — they turn a module change into a reviewable diff. Editing
 * `modules/gate/source/biome.json` otherwise shows one changed line with no indication of what lands in
 * a generated project.
 *
 * WHY THE CHECK IS THE FEATURE, NOT POLISH. A committed example that no longer matches what the
 * generator produces is a confident, wrong answer — worse than no example. `examples:check` is what
 * keeps that from happening silently, so it belongs in CI rather than in a contributor's memory.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: install dependencies or run the generated gate.
 * `tests/generation.test.ts` installs and gates ten of the sixteen combinations in temp directories, which
 * is both safer and more complete. Installing inside `examples/` would also fire the generated `prepare`
 * script, which runs `git config core.hooksPath .githooks` against THE FACTORY'S OWN repository — git
 * writes repo-level config regardless of the subdirectory you are standing in. See examples/README.md.
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  PackageManager,
  ProjectStructure,
  TestRunner,
} from '../modules/module-contract.js'
import { generateProject } from '../tests/generate-project.js'

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')
const EXAMPLES_DIRECTORY = path.join(FACTORY_ROOT, 'examples')

const REFRESH_MODE = 'refresh'
const CHECK_MODE = 'check'

const EXIT_CODE_FAILURE = 1

interface ExampleProject {
  /**
   * Directory under `examples/`, AND the generated project's name.
   *
   * These are deliberately the same string. Generating under one name and renaming afterwards would
   * make the drift check reproduce the rename too, and any mismatch there would surface as phantom
   * drift. Determinism beats a prettier `name` field in a `private: true` package nobody publishes.
   */
  readonly directoryName: string
  readonly packageManager: PackageManager
  readonly testRunner: TestRunner
  /** Omitted means `single`, matching the generator's own default. */
  readonly projectStructure?: ProjectStructure
  readonly enableFeatures: readonly string[]
  /** Why this combination is the one committed — surfaced in examples/README.md. */
  readonly rationale: string
}

/**
 * The committed combinations. Four of the sixteen, chosen for information density rather than coverage —
 * `tests/generation.test.ts` is what enumerates every reachable combination and gates ten of them.
 *
 * Three vary by package manager and runner; the fourth varies by LAYOUT, which is the only axis that
 * changes the shape of the tree rather than the contents of a few files.
 */
const EXAMPLE_PROJECTS: readonly ExampleProject[] = [
  {
    directoryName: 'npm',
    packageManager: 'npm',
    testRunner: 'vitest',
    enableFeatures: ['config'],
    rationale:
      'The default path. npm implies Node and therefore Vitest (the runner prompt is skipped), so this ' +
      'is the only shape an npm answer can produce.',
  },
  {
    directoryName: 'pnpm',
    packageManager: 'pnpm',
    testRunner: 'vitest',
    enableFeatures: ['config'],
    rationale:
      'Committed despite differing from the npm example in only a handful of files, because those files ' +
      'are the ones people get wrong: the lockfile rule, and the CI step ORDER that pnpm requires.',
  },
  {
    directoryName: 'bun',
    packageManager: 'bun',
    testRunner: 'bun-test',
    enableFeatures: ['config'],
    rationale:
      "Bun with its own test runner. Chosen over bun + Vitest because that combination differs from the " +
      'npm example in only a handful of files, while this one is a genuinely different tree.',
  },
  {
    directoryName: 'monorepo',
    packageManager: 'npm',
    testRunner: 'vitest',
    projectStructure: 'monorepo',
    enableFeatures: ['config'],
    rationale:
      'The workspace layout, which is the only example that differs STRUCTURALLY rather than in a few ' +
      'files — source moves under packages/<name>/ while config stays at the root. Paired with npm + ' +
      'Vitest because that is the layout at its plainest: the manager and runner deltas are already ' +
      'readable in the other three examples, so this one isolates the layout.',
  },
]

/**
 * Committed example directories that no longer correspond to an entry in `EXAMPLE_PROJECTS`.
 *
 * WHY THIS IS SEPARATE FROM THE DRIFT CHECK. `checkExamples` iterates the LIST, reporting MISSING or
 * DRIFT for each entry it expects — so a committed directory that was dropped from the list is invisible
 * to it and passes green. `findDrift`'s comment claims "NOTHING is excluded from the comparison", and
 * this was the hole in that claim.
 *
 * Found the hard way: renaming the `node` example to `npm` left `examples/node` on disk, still committed,
 * describing a `projectRuntime` answer the generator no longer accepts, and `examples:check` said ok.
 */
async function findOrphanedExampleDirectories(): Promise<string[]> {
  const expectedDirectoryNames = new Set(EXAMPLE_PROJECTS.map((example) => example.directoryName))
  const entries = await readdir(EXAMPLES_DIRECTORY, { withFileTypes: true })

  return entries
    .filter((entry) => entry.isDirectory() && !expectedDirectoryNames.has(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/** Every file under a directory, as paths relative to it. Sorted, so comparisons are deterministic. */
async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort()
}

/** Whether the owner-executable bit is set — the property a copied git hook silently loses. */
async function isExecutable(filePath: string): Promise<boolean> {
  const OWNER_EXECUTE_BIT = 0o100
  const fileStats = await stat(filePath)
  return (fileStats.mode & OWNER_EXECUTE_BIT) !== 0
}

interface DriftReport {
  readonly missing: readonly string[]
  readonly unexpected: readonly string[]
  readonly changed: readonly string[]
  readonly modeChanged: readonly string[]
}

/**
 * Compares a freshly generated tree against the committed one.
 *
 * NOTHING is excluded from the comparison. If a file is noisy enough to want excluding, that is a
 * finding about the generator — non-determinism in generated output — not a reason to look away.
 *
 * Executable bits are compared as well as content, because that is a real property of generated output
 * (`.githooks/pre-commit` is inert without it) and one that a careless copy drops without changing a
 * single byte.
 */
async function findDrift(options: {
  readonly generatedDirectory: string
  readonly committedDirectory: string
}): Promise<DriftReport> {
  const { generatedDirectory, committedDirectory } = options

  const generatedFiles = await listFilesRecursively(generatedDirectory)
  const committedFiles = await listFilesRecursively(committedDirectory)
  const committedFileSet = new Set(committedFiles)
  const generatedFileSet = new Set(generatedFiles)

  const missing = generatedFiles.filter((filePath) => !committedFileSet.has(filePath))
  const unexpected = committedFiles.filter((filePath) => !generatedFileSet.has(filePath))

  const changed: string[] = []
  const modeChanged: string[] = []
  for (const filePath of generatedFiles) {
    if (!committedFileSet.has(filePath)) {
      continue
    }
    const generatedPath = path.join(generatedDirectory, filePath)
    const committedPath = path.join(committedDirectory, filePath)

    const [generatedContents, committedContents] = await Promise.all([
      readFile(generatedPath),
      readFile(committedPath),
    ])
    if (!generatedContents.equals(committedContents)) {
      changed.push(filePath)
    }

    const [generatedExecutable, committedExecutable] = await Promise.all([
      isExecutable(generatedPath),
      isExecutable(committedPath),
    ])
    if (generatedExecutable !== committedExecutable) {
      modeChanged.push(filePath)
    }
  }

  return { missing, unexpected, changed, modeChanged }
}

async function refreshExamples(): Promise<number> {
  for (const example of EXAMPLE_PROJECTS) {
    const targetDirectory = path.join(EXAMPLES_DIRECTORY, example.directoryName)

    // The generator refuses a non-empty destination (`assertEmptyDestination`), so the previous copy has
    // to go first. This is also what makes refresh idempotent rather than additive: a file the generator
    // no longer produces disappears instead of lingering.
    await rm(targetDirectory, { recursive: true, force: true })

    await generateProject({
      projectName: example.directoryName,
      workspaceDirectory: EXAMPLES_DIRECTORY,
      packageManager: example.packageManager,
      testRunner: example.testRunner,
      projectStructure: example.projectStructure,
      enableFeatures: example.enableFeatures,
    })
    const fileCount = (await listFilesRecursively(targetDirectory)).length
    process.stdout.write(
      // Names the LAYOUT as well as the manager and runner. Without it the monorepo example logged as
      // `npm + vitest` — identical to the npm example, and hiding the one axis it exists to show.
      `  regenerated examples/${example.directoryName} ` +
        `(${example.projectStructure ?? 'single'} + ${example.packageManager} + ` +
        `${example.testRunner}, ${fileCount} files)\n`,
    )
  }
  process.stdout.write('\nexamples:refresh done. Review the diff before committing.\n')
  return 0
}

async function checkExamples(): Promise<number> {
  const workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), 'slop-factory-examples-'))
  let driftFound = false

  try {
    for (const example of EXAMPLE_PROJECTS) {
      const committedDirectory = path.join(EXAMPLES_DIRECTORY, example.directoryName)
      try {
        await stat(committedDirectory)
      } catch {
        process.stderr.write(
          `  MISSING examples/${example.directoryName} — run \`npm run examples:refresh\`\n`,
        )
        driftFound = true
        continue
      }

      const generatedDirectory = await generateProject({
        projectName: example.directoryName,
        workspaceDirectory,
        packageManager: example.packageManager,
        testRunner: example.testRunner,
        projectStructure: example.projectStructure,
        enableFeatures: example.enableFeatures,
      })

      const drift = await findDrift({ generatedDirectory, committedDirectory })
      const totalDrift =
        drift.missing.length + drift.unexpected.length + drift.changed.length + drift.modeChanged.length

      if (totalDrift === 0) {
        process.stdout.write(`  ok  examples/${example.directoryName}\n`)
        continue
      }

      driftFound = true
      process.stderr.write(`  DRIFT examples/${example.directoryName}\n`)
      for (const filePath of drift.missing) {
        process.stderr.write(`    generator produces but example lacks: ${filePath}\n`)
      }
      for (const filePath of drift.unexpected) {
        process.stderr.write(`    example has but generator no longer produces: ${filePath}\n`)
      }
      for (const filePath of drift.changed) {
        process.stderr.write(`    content differs: ${filePath}\n`)
      }
      for (const filePath of drift.modeChanged) {
        process.stderr.write(`    executable bit differs: ${filePath}\n`)
      }
    }

    // Checked AFTER the per-example loop, because it is a question about the directory as a whole rather
    // than about any one example: which committed trees does no entry in EXAMPLE_PROJECTS claim?
    for (const directoryName of await findOrphanedExampleDirectories()) {
      process.stderr.write(
        `  ORPHAN examples/${directoryName} — no entry in EXAMPLE_PROJECTS produces this tree. ` +
          'Delete it, or add the combination that generates it.\n',
      )
      driftFound = true
    }
  } finally {
    await rm(workspaceDirectory, { recursive: true, force: true })
  }

  if (driftFound) {
    process.stderr.write(
      '\nexamples:check failed. The committed examples no longer match what the generator produces.\n' +
        'Run `npm run examples:refresh` and commit the result as part of the change that caused it.\n',
    )
    return EXIT_CODE_FAILURE
  }

  process.stdout.write('\nexamples:check passed — committed examples match the generator.\n')
  return 0
}

const [mode] = process.argv.slice(2)

if (mode === REFRESH_MODE) {
  process.exit(await refreshExamples())
}
if (mode === CHECK_MODE) {
  process.exit(await checkExamples())
}

process.stderr.write(`usage: examples.ts <${REFRESH_MODE}|${CHECK_MODE}>\n`)
process.exit(EXIT_CODE_FAILURE)
