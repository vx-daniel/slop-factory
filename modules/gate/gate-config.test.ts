import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the Biome version pin that the factory and its output share.
 *
 * Adopting Biome for the factory turned `modules/gate/source/biome.json` from pure payload into live
 * configuration — `biome.jsonc` extends it. That is deliberate: the rules cannot drift, because there is only
 * one copy of them. But it left one coupling nothing else checks, and it fails quietly.
 *
 * The OTHER coupling that arrangement created — the byte-identical `.biome/naming.grit` copy at the factory
 * root — moved to `modules/payload-copies.test.ts` once a second such copy appeared. Both are the same idea:
 * a file the factory uses that is authoritatively owned by its payload.
 */

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..', '..')
const GATE_MODULE_PATH = path.join(import.meta.dirname, 'module.ts')

/** Reads the exact version string the gate module pins for generated projects. */
async function readShippedBiomeVersion(): Promise<string | undefined> {
  const gateModuleSource = await readFile(GATE_MODULE_PATH, 'utf8')
  return gateModuleSource.match(/const BIOME_VERSION = '([^']+)'/)?.[1]
}

/** Reads the version the FACTORY installs for itself. */
async function readFactoryBiomeVersion(): Promise<string | undefined> {
  const packageJson = JSON.parse(await readFile(path.join(FACTORY_ROOT, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>
  }
  return packageJson.devDependencies?.['@biomejs/biome']
}

describe('the factory gate and the gate it ships', () => {
  it('pin the same Biome version, exactly', async () => {
    // TWO INDEPENDENT PINS FOR ONE TOOL. `modules/gate/module.ts` pins the version generated projects
    // install; `package.json` pins the one the factory lints itself with. Nothing else compares them.
    //
    // Why they must agree rather than merely overlap: `biome.jsonc` EXTENDS the shipped config, so the
    // factory claims to be held to the standard it prescribes. A different Biome version can enforce that
    // same config differently — the shipped pin's own comment gives the reason, that "a Biome minor can add
    // rules, which would turn a green gate red on an unrelated install". If the factory floats ahead, it
    // lints against rules its generated projects will never see, and the claim quietly stops being true.
    //
    // Why EXACT on both sides, no caret: a caret on the factory side is exactly how it floats ahead.
    const [shippedVersion, factoryVersion] = await Promise.all([readShippedBiomeVersion(), readFactoryBiomeVersion()])

    expect(shippedVersion, 'BIOME_VERSION not found in modules/gate/module.ts').toBeDefined()
    expect(factoryVersion, '@biomejs/biome missing from the factory devDependencies').toBeDefined()
    expect(
      factoryVersion,
      `the factory pins Biome at ${factoryVersion} while shipping ${shippedVersion}. Pin both exactly ` +
        'and identically, or the factory lints itself against rules its output never sees.',
    ).toBe(shippedVersion)
  })
})
