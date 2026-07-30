import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_FIRST_PACKAGE_NAME,
  packageRootRelativePath,
  WORKSPACE_PACKAGES_DIRECTORY,
} from '../modules/module-contract.js'
import { generateProject } from './generate-project.js'

/**
 * Asserts WHERE the generator puts things, without installing anything.
 *
 * Deliberately its own suite rather than more cases in `generation.test.ts`. That one installs
 * dependencies and runs each generated project's full gate — minutes of real work per combination — which
 * is the right price for "does the project actually build" and far too high for "did this file land in the
 * right directory". File placement is decided entirely by the copy actions, so generating into a temp
 * directory and reading the tree proves it outright.
 *
 * This is also the only suite that exercises the `monorepo` layout at all. `toProjectAnswers` forces
 * `single` for anything a prompt produces, because the per-module template changes that make a generated
 * workspace build are not in place yet — so without these tests the package-root plumbing would be
 * written but unexercised, which is indistinguishable from broken.
 */

const CONFIG_FEATURE = ['config'] as const

/** A file the config module ships from `packageSource/` — it MOVES with the package root. */
const PACKAGE_RELATIVE_FILE = path.join('src', 'config', 'config.ts')

/**
 * Files the config module ships from `source/` — they stay at the REPOSITORY root under every layout.
 *
 * `config.defaults.toml` is the load-bearing one: the loader walks UP the tree to find it, so moving it
 * into the package would break config resolution for every other package in the workspace.
 */
const PROJECT_RELATIVE_FILES = ['config.defaults.toml', '.env.example', path.join('docs', 'configuration.md')]

let workspaceDirectory: string

beforeAll(async () => {
  workspaceDirectory = await mkdtemp(path.join(os.tmpdir(), 'slop-factory-layout-'))
})

afterAll(async () => {
  await rm(workspaceDirectory, { recursive: true, force: true })
})

/** Whether a path exists, as a boolean rather than a rejection, so both directions read the same. */
async function exists(filePath: string): Promise<boolean> {
  return access(filePath)
    .then(() => true)
    .catch(() => false)
}

describe('packageRootRelativePath', () => {
  it('collapses to the project root for a single-package layout', () => {
    // `.` rather than an empty string, because `path.join(destination, '')` and
    // `path.join(destination, '.')` both yield the destination but only one of them is a valid path.
    expect(packageRootRelativePath({ projectStructure: 'single', firstPackageName: 'core' })).toBe('.')
  })

  it('points into the workspace directory for a monorepo layout', () => {
    expect(packageRootRelativePath({ projectStructure: 'monorepo', firstPackageName: 'core' })).toBe(
      `${WORKSPACE_PACKAGES_DIRECTORY}/core`,
    )
  })

  it('uses the given package name rather than a fixed one', () => {
    // A hardcoded `core` here would pass every other assertion in this file, because `core` is also the
    // default — so this is the one that would catch it.
    expect(
      packageRootRelativePath({ projectStructure: 'monorepo', firstPackageName: 'billing' }),
    ).toBe(`${WORKSPACE_PACKAGES_DIRECTORY}/billing`)
  })
})

describe('single-package layout', () => {
  let projectDirectory: string

  beforeAll(async () => {
    projectDirectory = await generateProject({
      projectName: 'single-layout',
      workspaceDirectory,
      packageManager: 'npm',
      testRunner: 'vitest',
      enableFeatures: [...CONFIG_FEATURE],
    })
  })

  it('puts package source at the project root', async () => {
    expect(await exists(path.join(projectDirectory, PACKAGE_RELATIVE_FILE))).toBe(true)
  })

  it('creates no packages directory', async () => {
    expect(
      await exists(path.join(projectDirectory, WORKSPACE_PACKAGES_DIRECTORY)),
      'a single-package project must not contain a workspace directory',
    ).toBe(false)
  })

  it('writes no workspaces field', async () => {
    // Absent, not empty. `"workspaces": []` would make npm treat the project as a workspace root with
    // no members, which changes install behaviour for a project that is not a workspace at all.
    const packageJson = JSON.parse(
      await readFile(path.join(projectDirectory, 'package.json'), 'utf8'),
    ) as Record<string, unknown>

    expect(packageJson).not.toHaveProperty('workspaces')
  })
})

describe('monorepo layout', () => {
  let projectDirectory: string

  beforeAll(async () => {
    projectDirectory = await generateProject({
      projectName: 'monorepo-layout',
      workspaceDirectory,
      packageManager: 'npm',
      testRunner: 'vitest',
      projectStructure: 'monorepo',
      enableFeatures: [...CONFIG_FEATURE],
    })
  })

  it('moves package source under the first package', async () => {
    const packageRelativePath = path.join(
      projectDirectory,
      WORKSPACE_PACKAGES_DIRECTORY,
      DEFAULT_FIRST_PACKAGE_NAME,
      PACKAGE_RELATIVE_FILE,
    )

    expect(
      await exists(packageRelativePath),
      `${PACKAGE_RELATIVE_FILE} should land under ${WORKSPACE_PACKAGES_DIRECTORY}/${DEFAULT_FIRST_PACKAGE_NAME}/`,
    ).toBe(true)
  })

  it('leaves nothing behind at the project root', async () => {
    // The failure this catches is a copy that ADDS the package location without removing the old one,
    // giving the project two copies of its source that drift independently.
    expect(
      await exists(path.join(projectDirectory, PACKAGE_RELATIVE_FILE)),
      `${PACKAGE_RELATIVE_FILE} is package-relative and must NOT also exist at the project root`,
    ).toBe(false)
  })

  it('keeps project-relative files at the project root', async () => {
    for (const projectRelativeFile of PROJECT_RELATIVE_FILES) {
      expect(
        await exists(path.join(projectDirectory, projectRelativeFile)),
        `${projectRelativeFile} belongs at the repository root under every layout`,
      ).toBe(true)
    }
  })

  it('writes the workspaces glob', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectDirectory, 'package.json'), 'utf8'),
    ) as { workspaces?: readonly string[] }

    expect(packageJson.workspaces).toEqual([`${WORKSPACE_PACKAGES_DIRECTORY}/*`])
  })
})

describe('monorepo layout with a named package', () => {
  it('honours a first package name other than the default', async () => {
    const namedPackage = 'billing'
    const projectDirectory = await generateProject({
      projectName: 'monorepo-named',
      workspaceDirectory,
      packageManager: 'npm',
      testRunner: 'vitest',
      projectStructure: 'monorepo',
      firstPackageName: namedPackage,
      enableFeatures: [...CONFIG_FEATURE],
    })

    expect(
      await exists(
        path.join(projectDirectory, WORKSPACE_PACKAGES_DIRECTORY, namedPackage, PACKAGE_RELATIVE_FILE),
      ),
    ).toBe(true)
    expect(
      await exists(
        path.join(
          projectDirectory,
          WORKSPACE_PACKAGES_DIRECTORY,
          DEFAULT_FIRST_PACKAGE_NAME,
          PACKAGE_RELATIVE_FILE,
        ),
      ),
      'the default package name leaked through instead of the supplied one',
    ).toBe(false)
  })
})

describe('answer validation', () => {
  it('rejects a package name that would escape the workspace directory', async () => {
    // `path.join` would happily resolve `packages/../..` to somewhere outside the destination, which is
    // how a generator writes over files it was never pointed at.
    await expect(
      generateProject({
        projectName: 'escape-attempt',
        workspaceDirectory,
        packageManager: 'npm',
        testRunner: 'vitest',
        projectStructure: 'monorepo',
        firstPackageName: '../../etc',
        enableFeatures: [],
      }),
    ).rejects.toThrow(/single directory name/)
  })

  it('rejects an unknown project structure', async () => {
    await expect(
      generateProject({
        projectName: 'bad-structure',
        workspaceDirectory,
        packageManager: 'npm',
        testRunner: 'vitest',
        // Deliberately outside the union — the guard exists for exactly the case the types forbid but a
        // renamed prompt could still produce at runtime.
        projectStructure: 'multirepo' as never,
        enableFeatures: [],
      }),
    ).rejects.toThrow(/projectStructure must be one of/)
  })
})
