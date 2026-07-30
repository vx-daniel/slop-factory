import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_COPY_TREE_DIRECTORY_NAMES } from './module-contract.js'

const MODULES_DIRECTORY = import.meta.dirname
const FACTORY_ROOT = path.resolve(MODULES_DIRECTORY, '..')

/**
 * Configs that must exclude every copy tree, and cannot import the list that names them.
 *
 * All three are JSON, so `MODULE_COPY_TREES` is unreachable from them and the globs are written by hand.
 * That makes "added a copy tree, forgot a config" a silent failure with three different symptoms: tsc
 * reporting errors in files that are correct where they actually live, oxlint doing the same, and the
 * build compiling payload `.ts` that must stay `.ts`. This list is what makes the hand-maintenance safe.
 *
 * `vitest.config.ts` is deliberately absent — it is TypeScript and derives its globs from the contract.
 */
const CONFIGS_EXCLUDING_COPY_TREES = ['tsconfig.json', 'tsconfig.build.json', '.oxlintrc.json']

/**
 * Filenames npm interprets as ignore rules when building a tarball.
 *
 * These are checked because npm honours them ANYWHERE inside the package, not just at the root — and a
 * module's `source/` tree is payload, so an ignore file there silently deletes template files from the
 * published package while the working tree looks perfect.
 *
 * This is not hypothetical. `modules/base/source/.codegraph/.gitignore` used to exist containing:
 *
 *     *
 *     !.gitignore
 *
 * Measured with `npm pack --dry-run`: a sibling file in the same directory was excluded from the
 * tarball. It happened to be harmless there (the directory held nothing else, and the generated
 * project's root `.gitignore` already ignores `.codegraph/` entirely, making the file dead weight) but
 * the same pattern one directory higher would have silently shipped a broken package.
 *
 * The project `.gitignore` a generated project needs is produced from `modules/base/gitignore.hbs`, a
 * RENDERED template outside any `source/` tree — which is where any such file belongs.
 */
const NPM_IGNORE_FILENAMES = ['.gitignore', '.npmignore']

/** Recursively collects every file path under a directory, relative to it. */
async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
}

/** Module directory names, discovered rather than listed, so a new module is covered automatically. */
async function listModuleNames(): Promise<string[]> {
  const entries = await readdir(MODULES_DIRECTORY, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

describe('module copy trees', () => {
  it('contain no file npm would treat as an ignore rule', async () => {
    const offenders: string[] = []

    for (const moduleName of await listModuleNames()) {
      // EVERY copy tree, not just `source/`. The pack-filter hazard is a property of being payload
      // inside the published package, which both trees are.
      for (const copyTreeDirectoryName of MODULE_COPY_TREE_DIRECTORY_NAMES) {
        const copyTreeDirectory = path.join(MODULES_DIRECTORY, moduleName, copyTreeDirectoryName)
        let files: string[]
        try {
          files = await listFilesRecursively(copyTreeDirectory)
        } catch {
          // A module missing a given copy tree is legitimate; it simply has nothing to check.
          continue
        }

        for (const filePath of files) {
          if (NPM_IGNORE_FILENAMES.includes(path.basename(filePath))) {
            offenders.push(`${moduleName}/${copyTreeDirectoryName}/${filePath}`)
          }
        }
      }
    }

    expect(
      offenders,
      'npm honours these as pack filters and would silently drop template files from the published ' +
        'package. A generated project gets its .gitignore from modules/base/gitignore.hbs instead.',
    ).toEqual([])
  })

  it('has at least one module shipping each copy tree, so the check is not vacuous', async () => {
    // A guard that passes because it found nothing to look at is not a guard. If a copy tree stopped
    // existing anywhere, the assertion above would still pass — this makes that state fail instead.
    // Asserted PER TREE rather than in aggregate: `source/` alone would otherwise satisfy it while
    // `packageSource/` silently held nothing.
    const moduleNames = await listModuleNames()

    for (const copyTreeDirectoryName of MODULE_COPY_TREE_DIRECTORY_NAMES) {
      const modulesShippingThisTree: string[] = []

      for (const moduleName of moduleNames) {
        try {
          const files = await listFilesRecursively(
            path.join(MODULES_DIRECTORY, moduleName, copyTreeDirectoryName),
          )
          if (files.length > 0) {
            modulesShippingThisTree.push(moduleName)
          }
        } catch {
          continue
        }
      }

      expect(
        modulesShippingThisTree.length,
        `no module ships a ${copyTreeDirectoryName}/ tree, so its checks are vacuous`,
      ).toBeGreaterThan(0)
    }
  })

  it('are excluded by every config that cannot import the copy-tree list', async () => {
    // The three JSON configs write their globs by hand because JSON cannot import
    // `MODULE_COPY_TREES`. Without this, adding a copy tree passes every other check and then breaks
    // tsc, oxlint, or the build with a symptom that points at the payload file rather than the config.
    //
    // MATCHES THE QUOTED FORM, and the quotes are the whole point. An earlier version searched for the
    // bare glob text and did not fail when the real exclude was deleted — because these files' own
    // COMMENTS name the trees they exclude (```modules/*/packageSource/**```), so the match succeeded on
    // the prose. Verified by deleting the entry and watching the test still pass. A glob only counts as
    // configuration when it appears as a JSON string, which is what the surrounding quotes assert.
    //
    // Deliberately stricter than "somewhere in the exclude array": writing the entry with a `/**` suffix
    // would fail this even though tsc would accept it. That is the safe direction to be wrong in — a
    // false positive fails loudly and is a one-line fix, where the false negative it replaces was silent.
    for (const configFileName of CONFIGS_EXCLUDING_COPY_TREES) {
      const configContents = await readFile(path.join(FACTORY_ROOT, configFileName), 'utf8')

      for (const copyTreeDirectoryName of MODULE_COPY_TREE_DIRECTORY_NAMES) {
        expect(
          configContents,
          `${configFileName} has no "modules/*/${copyTreeDirectoryName}" exclude entry — payload ` +
            'files would be typechecked, linted, or compiled as if they were factory code. A mention ' +
            'in a comment does not count; it must be a quoted glob.',
        ).toContain(`"modules/*/${copyTreeDirectoryName}"`)
      }
    }
  })
})
