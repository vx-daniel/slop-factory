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
 * It is also where OPT-IN FEATURES are checked. A feature that contributes no dependencies and no scripts —
 * `claude-workflows` is the case — cannot affect install or the generated gate, so file placement is the
 * entire surface. Adding it to `generation.test.ts` would double that matrix to gate nothing new.
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
    expect(packageRootRelativePath({ projectStructure: 'monorepo', firstPackageName: 'billing' })).toBe(
      `${WORKSPACE_PACKAGES_DIRECTORY}/billing`,
    )
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
    const packageJson = JSON.parse(await readFile(path.join(projectDirectory, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >

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
    const packageJson = JSON.parse(await readFile(path.join(projectDirectory, 'package.json'), 'utf8')) as {
      workspaces?: readonly string[]
    }

    expect(packageJson.workspaces).toEqual([`${WORKSPACE_PACKAGES_DIRECTORY}/*`])
  })
})

describe('monorepo layout — the files other modules own', () => {
  let projectDirectory: string

  beforeAll(async () => {
    projectDirectory = await generateProject({
      projectName: 'monorepo-templates',
      workspaceDirectory,
      packageManager: 'npm',
      testRunner: 'vitest',
      projectStructure: 'monorepo',
      enableFeatures: [...CONFIG_FEATURE],
    })
  })

  it('points the tsconfig alias at the package and covers every package', async () => {
    const tsconfig = await readFile(path.join(projectDirectory, 'tsconfig.json'), 'utf8')

    expect(tsconfig, 'the alias must name the package, not `@/*`').toContain(
      `"@${DEFAULT_FIRST_PACKAGE_NAME}/*": ["./${WORKSPACE_PACKAGES_DIRECTORY}/${DEFAULT_FIRST_PACKAGE_NAME}/src/*"]`,
    )
    // `packages/*/test` is not optional: the `bun test` type shim lives there, and omitting it fails
    // every test file with "Cannot find module 'vitest'".
    expect(tsconfig).toContain(`"${WORKSPACE_PACKAGES_DIRECTORY}/*/src"`)
    expect(tsconfig).toContain(`"${WORKSPACE_PACKAGES_DIRECTORY}/*/test"`)
    expect(tsconfig, 'the single-package alias must not survive').not.toContain('"@/*"')
  })

  it('omits test.include from the vitest config, because --dir supplies discovery', async () => {
    // THE assertion for this layout. `test.include` resolves relative to `--dir`, so the two stack into
    // `packages/packages/**` and match nothing — reporting only the unmatched glob, which reads like a
    // broken path rather than a doubling. Matching the `include:` KEY at test level, not in a comment.
    const vitestConfig = await readFile(path.join(projectDirectory, 'vitest.config.ts'), 'utf8')
    const includeKeyLines = vitestConfig.split('\n').filter((line) => /^\s{4}include:/.test(line))

    expect(includeKeyLines, 'test.include must be absent when --dir packages is used').toEqual([])
    // Coverage include is a DIFFERENT key, resolved from the project root, and must keep its prefix.
    expect(vitestConfig).toContain(`'${WORKSPACE_PACKAGES_DIRECTORY}/*/src/**/*.ts'`)
  })

  it('scopes both test and coverage scripts to the workspace directory', async () => {
    // Both, not one. Scoping only `test` would leave the gate passing while `coverage` measured a
    // different set of files — the quieter of the two failures.
    const packageJson = JSON.parse(await readFile(path.join(projectDirectory, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(packageJson.scripts.test).toContain(`--dir ${WORKSPACE_PACKAGES_DIRECTORY}`)
    expect(packageJson.scripts.coverage).toContain(`--dir ${WORKSPACE_PACKAGES_DIRECTORY}`)
  })

  it('gives the first package its own package.json', async () => {
    // A directory under packages/ without one is not a workspace member: the manager ignores it, and the
    // single-lockfile-at-the-root arrangement silently does not apply to it.
    const packageJson = JSON.parse(
      await readFile(
        path.join(projectDirectory, WORKSPACE_PACKAGES_DIRECTORY, DEFAULT_FIRST_PACKAGE_NAME, 'package.json'),
        'utf8',
      ),
    ) as { name: string; private: boolean }

    expect(packageJson.name).toBe(`@monorepo-templates/${DEFAULT_FIRST_PACKAGE_NAME}`)
    expect(packageJson.private).toBe(true)
  })

  it('documents paths that actually exist', async () => {
    // THE GUARD FOR A BUG THAT SHIPPED. `CLAUDE.md` and `README.md` are written for the reader of a
    // generated project and both state where things are. The workspace layout landed with both still
    // saying `@/*` → `src/*` and pointing at `src/config/config.ts`. The project worked; its own
    // documentation directed an agent to paths that did not exist — worse than no documentation, because
    // it reads as authoritative. Nothing checked prose, which is why nothing caught it.
    //
    // Asserts the path is RESOLVABLE rather than that the text matches a pattern, so it stays true if the
    // wording changes. The `@`-prefixed alias is matched as a token to avoid the comment-vs-prose trap
    // described in .claude/rules/asserting-on-file-content.md — these documents legitimately discuss both
    // layouts, so a bare `src/` search would match explanation.
    const packageSourceDirectory = `${WORKSPACE_PACKAGES_DIRECTORY}/${DEFAULT_FIRST_PACKAGE_NAME}/src`

    for (const documentName of ['CLAUDE.md', 'README.md']) {
      const contents = await readFile(path.join(projectDirectory, documentName), 'utf8')

      expect(contents, `${documentName} does not mention the real source directory`).toContain(packageSourceDirectory)
      expect(contents, `${documentName} still advertises the single-package alias`).not.toContain('`@/*`')
      expect(contents, `${documentName} should name the per-package alias`).toContain(
        `\`@${DEFAULT_FIRST_PACKAGE_NAME}/*\``,
      )
    }

    // And the path it names is real, not merely well-formed.
    await expect(
      access(path.join(projectDirectory, packageSourceDirectory, 'config', 'config.ts')),
    ).resolves.toBeUndefined()
  })

  it('ships the monorepo document and links it from the index', async () => {
    await expect(access(path.join(projectDirectory, 'docs', 'monorepo.md'))).resolves.toBeUndefined()

    const documentIndex = await readFile(path.join(projectDirectory, 'docs', 'README.md'), 'utf8')
    expect(documentIndex).toContain('(monorepo.md)')
  })
})

describe('single layout — no workspace vocabulary leaks in', () => {
  let projectDirectory: string

  beforeAll(async () => {
    projectDirectory = await generateProject({
      projectName: 'single-templates',
      workspaceDirectory,
      packageManager: 'bun',
      testRunner: 'bun-test',
      enableFeatures: [...CONFIG_FEATURE],
    })
  })

  it('keeps the @/* alias and the src/test includes', async () => {
    const tsconfig = await readFile(path.join(projectDirectory, 'tsconfig.json'), 'utf8')

    expect(tsconfig).toContain('"@/*": ["./src/*"]')
    expect(tsconfig).toContain('"include": ["src", "test", "scripts"')

    // Asserts the QUOTED forms, not the bare word `packages`. This file's own comments explain what the
    // workspace layout does differently, so they legitimately contain that word — a bare
    // `not.toContain('packages')` matched the prose and failed against a correct config. Third instance
    // of that trap in this repo (see the ci.yml install-command test, and the copy-tree config guard in
    // modules/module-sources.test.ts): text-matching a config whose comments discuss the thing being
    // checked needs the quotes to tell configuration from explanation.
    expect(tsconfig, 'a workspace include glob leaked into a single-package project').not.toContain(
      `"${WORKSPACE_PACKAGES_DIRECTORY}/*/src"`,
    )
    expect(tsconfig, 'a per-package alias leaked into a single-package project').not.toContain(
      `"@${DEFAULT_FIRST_PACKAGE_NAME}/*"`,
    )
  })

  it('sets no discovery root in bunfig, so the whole project is scanned', async () => {
    // `root` scopes discovery to a directory. A single-package project has no `packages/`, so setting it
    // would find zero test files — and `bun test` treats that as a hard exit 1 with no flag to soften it.
    const bunfig = await readFile(path.join(projectDirectory, 'bunfig.toml'), 'utf8')
    const rootLines = bunfig.split('\n').filter((line) => /^\s*root\s*=/.test(line))

    expect(rootLines, 'bunfig must not scope discovery in a single-package project').toEqual([])
  })

  it('puts the coverage floor guard where a bare bun test will find it', async () => {
    await expect(access(path.join(projectDirectory, 'test', 'coverage-floor.test.ts'))).resolves.toBeUndefined()
  })

  it('creates no per-package package.json', async () => {
    expect(await exists(path.join(projectDirectory, WORKSPACE_PACKAGES_DIRECTORY))).toBe(false)
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
      await exists(path.join(projectDirectory, WORKSPACE_PACKAGES_DIRECTORY, namedPackage, PACKAGE_RELATIVE_FILE)),
    ).toBe(true)
    expect(
      await exists(
        path.join(projectDirectory, WORKSPACE_PACKAGES_DIRECTORY, DEFAULT_FIRST_PACKAGE_NAME, PACKAGE_RELATIVE_FILE),
      ),
      'the default package name leaked through instead of the supplied one',
    ).toBe(false)
  })
})

describe('the claude-workflows feature', () => {
  /** The three the feature adds. `secret-scan.yml` is NOT here — it ships from base, unconditionally. */
  const FEATURE_WORKFLOWS = ['claude-pr-review.yml', 'claude-issue-agent.yml', 'test-audit.yml']

  let enabledDirectory: string
  let disabledDirectory: string

  beforeAll(async () => {
    enabledDirectory = await generateProject({
      projectName: 'claude-workflows-on',
      workspaceDirectory,
      packageManager: 'npm',
      testRunner: 'vitest',
      enableFeatures: ['config', 'claude-workflows'],
    })
    disabledDirectory = await generateProject({
      projectName: 'claude-workflows-off',
      workspaceDirectory,
      packageManager: 'npm',
      testRunner: 'vitest',
      enableFeatures: ['config'],
    })
  })

  it('ships the three workflows and their document when enabled', async () => {
    for (const workflowName of FEATURE_WORKFLOWS) {
      await expect(
        access(path.join(enabledDirectory, '.github', 'workflows', workflowName)),
        `${workflowName} missing with the feature enabled`,
      ).resolves.toBeUndefined()
    }
    await expect(access(path.join(enabledDirectory, 'docs', 'claude-workflows.md'))).resolves.toBeUndefined()
  })

  it('ships none of them when disabled', async () => {
    for (const workflowName of FEATURE_WORKFLOWS) {
      expect(
        await exists(path.join(disabledDirectory, '.github', 'workflows', workflowName)),
        `${workflowName} shipped despite the feature being off`,
      ).toBe(false)
    }
    expect(await exists(path.join(disabledDirectory, 'docs', 'claude-workflows.md'))).toBe(false)
  })

  it('ships secret-scan either way, because it needs no token', async () => {
    // The distinction the whole feature split rests on. gitleaks needs no secret, so it belongs in base and
    // works the moment a project is generated; the three above are inert without a token and so are opt-in.
    for (const projectDirectory of [enabledDirectory, disabledDirectory]) {
      await expect(
        access(path.join(projectDirectory, '.github', 'workflows', 'secret-scan.yml')),
      ).resolves.toBeUndefined()
    }
  })

  it('never mentions the token in a project that declined the feature', async () => {
    // The original complaint this whole change answers: a generated project should not carry instructions
    // about a secret it has no use for, nor files it is told to delete.
    for (const documentName of ['CLAUDE.md', 'README.md']) {
      const contents = await readFile(path.join(disabledDirectory, documentName), 'utf8')
      expect(contents, `${documentName} mentions the token without the feature`).not.toContain(
        'CLAUDE_CODE_OAUTH_TOKEN',
      )
    }
  })

  it('tells a project that enabled it which secret to set', async () => {
    for (const documentName of ['CLAUDE.md', 'README.md']) {
      const contents = await readFile(path.join(enabledDirectory, documentName), 'utf8')
      expect(contents, `${documentName} should name the required secret`).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    }
  })

  it('delegates to no external repository', async () => {
    // These began as thin callers into a private org repo, which is why every generated project used to ship
    // four files whose own comments told most adopters to delete them.
    for (const workflowName of [...FEATURE_WORKFLOWS, 'secret-scan.yml']) {
      const directory = workflowName === 'secret-scan.yml' ? disabledDirectory : enabledDirectory
      const contents = await readFile(path.join(directory, '.github', 'workflows', workflowName), 'utf8')
      expect(contents, `${workflowName} still delegates to a reusable workflow`).not.toMatch(
        /^\s*uses:\s*\S+\/\S+\/\.github\/workflows\//m,
      )
    }
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
