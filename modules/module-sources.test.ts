import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const MODULES_DIRECTORY = import.meta.dirname

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

describe('module source trees', () => {
  it('contain no file npm would treat as an ignore rule', async () => {
    const offenders: string[] = []

    for (const moduleName of await listModuleNames()) {
      const sourceDirectory = path.join(MODULES_DIRECTORY, moduleName, 'source')
      let files: string[]
      try {
        files = await listFilesRecursively(sourceDirectory)
      } catch {
        // A module with no source/ tree is legitimate; it simply has nothing to check.
        continue
      }

      for (const filePath of files) {
        if (NPM_IGNORE_FILENAMES.includes(path.basename(filePath))) {
          offenders.push(`${moduleName}/source/${filePath}`)
        }
      }
    }

    expect(
      offenders,
      'npm honours these as pack filters and would silently drop template files from the published ' +
        'package. A generated project gets its .gitignore from modules/base/gitignore.hbs instead.',
    ).toEqual([])
  })

  it('has at least one module shipping a source tree, so the check is not vacuous', async () => {
    // A guard that passes because it found nothing to look at is not a guard. If every source/ tree
    // disappeared, the assertion above would still pass — this makes that state fail instead.
    const moduleNames = await listModuleNames()
    const modulesWithSourceTrees: string[] = []

    for (const moduleName of moduleNames) {
      try {
        const files = await listFilesRecursively(path.join(MODULES_DIRECTORY, moduleName, 'source'))
        if (files.length > 0) {
          modulesWithSourceTrees.push(moduleName)
        }
      } catch {
        continue
      }
    }

    expect(modulesWithSourceTrees.length).toBeGreaterThan(0)
  })
})
