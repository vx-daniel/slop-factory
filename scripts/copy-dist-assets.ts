#!/usr/bin/env node
/**
 * Copies the non-TypeScript half of each module into `dist/`, after tsc has emitted the code half.
 *
 * WHY THIS IS NEEDED. `tsc` compiles only the factory's own `.ts` files. A module's real payload —
 * everything under `source/`, plus the `.hbs` templates — is data, not code: it is copied byte-for-byte
 * into generated projects, and several of those files are `.ts` that must REMAIN `.ts` because they are
 * the generated project's source. Running them through the compiler would be exactly wrong.
 *
 * WHY IT COPIES INTO `dist/` RATHER THAN LEAVING THEM AT THE ROOT. The plopfile resolves module assets
 * relative to its own directory (`plop.getPlopfilePath()`). Mirroring the layout inside `dist/` means
 * that one resolution rule works unchanged from source and from the published package — no "am I built?"
 * branch anywhere in the generator.
 */
import { cp, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { MODULE_COPY_TREE_DIRECTORY_NAMES } from '../modules/module-contract.js'

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')
const MODULES_DIRECTORY = path.join(FACTORY_ROOT, 'modules')
const DIST_MODULES_DIRECTORY = path.join(FACTORY_ROOT, 'dist', 'modules')

/** Extension marking a Handlebars template the generator renders rather than copies. */
const TEMPLATE_EXTENSION = '.hbs'

async function copyModuleAssets(moduleName: string): Promise<string[]> {
  const moduleDirectory = path.join(MODULES_DIRECTORY, moduleName)
  const distModuleDirectory = path.join(DIST_MODULES_DIRECTORY, moduleName)
  const copied: string[] = []

  const entries = await readdir(moduleDirectory, { withFileTypes: true })

  // Every copy tree, not just `source/`. Missing one here would publish a package whose generator
  // resolves that tree at generation time and finds nothing — a failure that only the CONSUMER sees.
  for (const copyTreeDirectoryName of MODULE_COPY_TREE_DIRECTORY_NAMES) {
    const hasCopyTree = entries.some((entry) => entry.isDirectory() && entry.name === copyTreeDirectoryName)
    if (!hasCopyTree) {
      continue
    }
    await mkdir(distModuleDirectory, { recursive: true })
    await cp(path.join(moduleDirectory, copyTreeDirectoryName), path.join(distModuleDirectory, copyTreeDirectoryName), {
      recursive: true,
    })
    copied.push(`${moduleName}/${copyTreeDirectoryName}/`)
  }

  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith(TEMPLATE_EXTENSION))) {
      continue
    }
    await mkdir(distModuleDirectory, { recursive: true })
    await cp(path.join(moduleDirectory, entry.name), path.join(distModuleDirectory, entry.name))
    copied.push(`${moduleName}/${entry.name}`)
  }

  return copied
}

const moduleDirectoryEntries = await readdir(MODULES_DIRECTORY, { withFileTypes: true })
const moduleNames = moduleDirectoryEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)

let totalCopied = 0
for (const moduleName of moduleNames) {
  const copied = await copyModuleAssets(moduleName)
  for (const description of copied) {
    process.stdout.write(`  copied ${description}\n`)
  }
  totalCopied += copied.length
}

process.stdout.write(`copy-dist-assets: ${totalCopied} asset group(s) copied into dist/modules/\n`)
