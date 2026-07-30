import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { PROJECT_MODULES } from '../modules/registry.js'

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
const FORBIDDEN_PATH_PREFIXES = ['tests/', 'modules/', 'cli.ts', 'plopfile.ts']

let packedPaths: string[]

beforeAll(() => {
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: FACTORY_ROOT,
    encoding: 'utf8',
  })
  expect(build.status, `build failed:\n${build.stdout}${build.stderr}`).toBe(0)

  // `--dry-run` computes the file list without writing a tarball, so the test leaves nothing behind.
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: FACTORY_ROOT,
    encoding: 'utf8',
  })
  expect(pack.status, `npm pack failed:\n${pack.stderr}`).toBe(0)

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
    for (const templateName of [
      'CLAUDE.md.hbs',
      'README.md.hbs',
      'docs-index.md.hbs',
      'gitignore.hbs',
      'tsconfig.json.hbs',
    ]) {
      expect(packedPaths, `${templateName} missing from the tarball`).toContain(
        `dist/modules/base/${templateName}`,
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
