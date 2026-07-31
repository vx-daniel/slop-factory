import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import vitestConfiguration from '../vitest.config.js'

/**
 * Guards that every Vitest project the factory defines is actually RUN by the factory's own CI.
 *
 * WHY THIS EXISTS. The `layout` project was added with the monorepo work, wired into `prepublishOnly`, and
 * never into `.github/workflows/ci.yml`. Nothing noticed across four pull requests, and two documents
 * meanwhile stated that it ran in CI. A Vitest project no workflow invokes is a suite that exists, passes
 * locally, and proves nothing about a pull request — the worst of the three, because it reads as coverage.
 *
 * WHY IT WALKS THE `npm run` GRAPH rather than looking for project names in the workflow. CI runs npm
 * SCRIPTS, not Vitest projects, and one of those scripts is composite: `check:all` reaches `test`, which is
 * the `unit` project. Matching project names against the workflow directly would fail on `unit` forever,
 * and matching script names without expanding composites would too.
 *
 * WHY IT READS ONLY `run:` LINES from the workflow, and only the `--project` flag from PARSED
 * package.json scripts. Both files are heavily commented, and their comments legitimately name the scripts
 * and suites they discuss — including the ones deliberately left out. A substring match against either
 * whole file would pass on a workflow that runs nothing. See `.claude/rules/asserting-on-file-content.md`.
 *
 * WHY NOT "runs in CI *or* in the pre-commit hook". That looser rule was the first shape considered and it
 * is a designed-in false negative: the hook's comment names `test:prompts` and `test:layout` precisely to
 * record that it does NOT run them, so a project mentioned there would satisfy the guard while running
 * nowhere. The hook is a subset of CI by design; CI is the only place this invariant means anything. Do not
 * loosen it back.
 */

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')
const CI_WORKFLOW_PATH = path.join(FACTORY_ROOT, '.github', 'workflows', 'ci.yml')
const PACKAGE_JSON_PATH = path.join(FACTORY_ROOT, 'package.json')

/** The flag by which a package.json script selects a Vitest project. */
const VITEST_PROJECT_FLAG = '--project'

/** Matches a `run:` step's command in the workflow, so comments mentioning a script are not read as one. */
const WORKFLOW_RUN_STEP_PATTERN = /^\s*run:\s*(\S.*)$/

/** Matches one script invoking another, which is how a composite script such as `check:all` is expanded. */
const NPM_RUN_REFERENCE_PATTERN = /npm run ([\w:-]+)/g

/**
 * How many projects `vitest.config.ts` declares.
 *
 * Pinned for the reason `modules/payload-copies.test.ts` pins its own count: a guard that derives its
 * subject list can lose the whole list — to a config refactor, or to a project shape this file cannot read
 * a name from — and still report green. That is the inert-guard failure this repository has hit twice.
 */
const EXPECTED_VITEST_PROJECT_COUNT = 5

/** The factory's package.json scripts, by name. */
async function readPackageJsonScripts(): Promise<Record<string, string>> {
  // Parsed rather than string-matched: `scripts` is real JSON, so no comment can reach it. This is the
  // strongest of the three forms in `asserting-on-file-content.md`, and package.json permits it.
  const packageJson = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf8')) as {
    scripts?: Record<string, string>
  }
  return packageJson.scripts ?? {}
}

/**
 * The `name` of one entry in `vitest.config.ts`'s `projects` array.
 *
 * Throws rather than returning undefined for an unreadable entry. Vitest also accepts a glob string or a
 * function where this file expects an inline config object; skipping those would silently shrink what the
 * guard covers, which is precisely the failure it exists to prevent.
 */
function readVitestProjectName(projectEntry: unknown, entryIndex: number): string {
  if (typeof projectEntry === 'object' && projectEntry !== null && 'test' in projectEntry) {
    const { test } = projectEntry
    if (typeof test === 'object' && test !== null && 'name' in test && typeof test.name === 'string') {
      return test.name
    }
  }
  throw new Error(
    `vitest.config.ts declares a project at index ${entryIndex} whose name this guard cannot read. ` +
      'It expects every entry to be an inline `{ test: { name } }` object. Teach this file the new shape ' +
      'rather than letting the project go unchecked.',
  )
}

/** Every project name declared in `vitest.config.ts`, read from the imported config rather than its text. */
function readVitestProjectNames(): readonly string[] {
  const projectEntries = vitestConfiguration.test?.projects ?? []
  return projectEntries.map(readVitestProjectName)
}

/** The project names one script selects, read as the token following each `--project` flag. */
function vitestProjectNamesRunByScript(scriptBody: string): readonly string[] {
  // Reading the token AFTER the flag, rather than substring-matching the project name, keeps `--project
  // unit` from also matching a hypothetical future `--project unit-extra`.
  const tokens = scriptBody.split(/\s+/)
  const projectNames: string[] = []
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    if (tokens[tokenIndex] === VITEST_PROJECT_FLAG) {
      const projectName = tokens[tokenIndex + 1]
      if (projectName !== undefined) {
        projectNames.push(projectName)
      }
    }
  }
  return projectNames
}

/**
 * Which package.json scripts select each Vitest project, keyed by project name.
 *
 * Both assertions below need this same mapping — one to check a project has exactly one script, the other
 * to check that script is reached by CI — so it is built once here rather than twice at the call sites.
 */
function scriptNamesByVitestProjectName(scripts: Record<string, string>): ReadonlyMap<string, readonly string[]> {
  const scriptNamesByProjectName = new Map<string, string[]>()
  for (const [scriptName, scriptBody] of Object.entries(scripts)) {
    for (const projectName of vitestProjectNamesRunByScript(scriptBody)) {
      const scriptNames = scriptNamesByProjectName.get(projectName) ?? []
      scriptNames.push(scriptName)
      scriptNamesByProjectName.set(projectName, scriptNames)
    }
  }
  return scriptNamesByProjectName
}

/** The names of the scripts `.github/workflows/ci.yml` invokes directly, ignoring its comments. */
function scriptNamesInvokedByWorkflow(workflowContents: string): readonly string[] {
  const scriptNames: string[] = []
  for (const workflowLine of workflowContents.split('\n')) {
    const runStepCommand = workflowLine.match(WORKFLOW_RUN_STEP_PATTERN)?.[1]
    if (runStepCommand === undefined) {
      continue
    }
    for (const [, scriptName] of runStepCommand.matchAll(NPM_RUN_REFERENCE_PATTERN)) {
      if (scriptName !== undefined) {
        scriptNames.push(scriptName)
      }
    }
  }
  return scriptNames
}

/**
 * Every script reachable from the given entry points, following `npm run` references between them.
 *
 * This is what makes the `unit` project resolvable: CI runs `check:all`, which runs `test`, which is the
 * only script naming that project.
 */
function scriptNamesReachableFrom(
  entryScriptNames: readonly string[],
  scripts: Record<string, string>,
): ReadonlySet<string> {
  const reachedScriptNames = new Set<string>()
  const scriptNamesToVisit = [...entryScriptNames]
  while (scriptNamesToVisit.length > 0) {
    const scriptName = scriptNamesToVisit.pop()
    if (scriptName === undefined || reachedScriptNames.has(scriptName)) {
      continue
    }
    reachedScriptNames.add(scriptName)
    const scriptBody = scripts[scriptName]
    if (scriptBody === undefined) {
      continue
    }
    for (const [, referencedScriptName] of scriptBody.matchAll(NPM_RUN_REFERENCE_PATTERN)) {
      if (referencedScriptName !== undefined) {
        scriptNamesToVisit.push(referencedScriptName)
      }
    }
  }
  return reachedScriptNames
}

describe('every Vitest project the factory declares', () => {
  it('is selected by exactly one package.json script', async () => {
    const scriptNamesByProjectName = scriptNamesByVitestProjectName(await readPackageJsonScripts())

    for (const projectName of readVitestProjectNames()) {
      expect(
        scriptNamesByProjectName.get(projectName) ?? [],
        `no package.json script runs the '${projectName}' Vitest project, so there is no way to run it ` +
          'other than by hand. Add a script for it, then add that script to .github/workflows/ci.yml.',
      ).toHaveLength(1)
    }
  })

  it('is reached by .github/workflows/ci.yml', async () => {
    const [scripts, workflowContents] = await Promise.all([
      readPackageJsonScripts(),
      readFile(CI_WORKFLOW_PATH, 'utf8'),
    ])
    const scriptNamesRunInCi = scriptNamesReachableFrom(scriptNamesInvokedByWorkflow(workflowContents), scripts)
    const scriptNamesByProjectName = scriptNamesByVitestProjectName(scripts)

    for (const projectName of readVitestProjectNames()) {
      const scriptNamesRunningProject = scriptNamesByProjectName.get(projectName) ?? []

      expect(
        scriptNamesRunningProject.filter((scriptName) => scriptNamesRunInCi.has(scriptName)),
        `the '${projectName}' Vitest project is not reached by .github/workflows/ci.yml. It is run by ` +
          `${scriptNamesRunningProject.join(', ') || 'no script'}, and CI reaches ` +
          `${[...scriptNamesRunInCi].sort().join(', ')}. A suite CI never runs proves nothing about a ` +
          'pull request while reading as coverage — add a step for it rather than removing the project.',
      ).not.toHaveLength(0)
    }
  })

  it('is covered by this guard, so the project list cannot quietly empty', () => {
    // A guard over an empty derived list passes. This makes that state fail instead, and pins the count so
    // adding a sixth Vitest project is a deliberate edit here rather than an omission nothing notices.
    expect(
      readVitestProjectNames(),
      'the project list read from vitest.config.ts changed size — wire the new project into ci.yml and ' +
        'update this count, or find out why a project disappeared.',
    ).toHaveLength(EXPECTED_VITEST_PROJECT_COUNT)
  })
})
