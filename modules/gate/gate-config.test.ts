import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the two places the factory's own gate touches the gate it SHIPS.
 *
 * Adopting Biome for the factory turned `modules/gate/source/biome.json` from pure payload into live
 * configuration — `biome.jsonc` extends it. That is deliberate: it means the rules cannot drift, because
 * there is only one copy of them. But it created two new couplings that nothing else checks, and both fail
 * quietly.
 */

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..', '..')
const GATE_MODULE_PATH = path.join(import.meta.dirname, 'module.ts')

/** The payload plugin, and the copy `biome.jsonc` actually loads. */
const SHIPPED_PLUGIN_PATH = path.join(import.meta.dirname, 'source', '.biome', 'naming.grit')
const FACTORY_PLUGIN_PATH = path.join(FACTORY_ROOT, '.biome', 'naming.grit')

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

  it('use the same naming plugin, byte for byte', async () => {
    // A COPY THAT MUST NOT DRIFT. `biome.jsonc` extends the shipped config, and `extends` inherits
    // `plugins: ["./.biome/naming.grit"]` — but that relative path resolves against the EXTENDING config's
    // directory, not the base's. Measured on Biome 2.5.6: pointing it at the payload path fails with
    // "Cannot read file" no matter how the path is written, so the factory needs its own copy at
    // `.biome/naming.grit`.
    //
    // An unguarded copy of a 13 KB rule file is precisely the drift the Biome switch existed to remove, so
    // this asserts byte-identity. If it fails, copy the payload one over the factory one — the payload is
    // the source of truth, because it is what adopters actually receive.
    const [shippedPlugin, factoryPlugin] = await Promise.all([
      readFile(SHIPPED_PLUGIN_PATH, 'utf8'),
      readFile(FACTORY_PLUGIN_PATH, 'utf8'),
    ])

    expect(
      factoryPlugin,
      '.biome/naming.grit has drifted from modules/gate/source/.biome/naming.grit. The payload copy is ' +
        'authoritative; copy it over the factory one rather than reconciling by hand.',
    ).toBe(shippedPlugin)
  })
})
