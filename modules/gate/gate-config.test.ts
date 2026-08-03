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
const SHIPPED_BIOME_CONFIG_PATH = path.join(import.meta.dirname, 'source', 'biome.json')
const FACTORY_BIOME_CONFIG_PATH = path.join(FACTORY_ROOT, 'biome.jsonc')

/**
 * The exclusion that must stay anchored to the config's own directory, and the form that breaks it.
 *
 * Biome matches `files.includes` against the ABSOLUTE path, so a leading globstar here excludes any tree that
 * merely SITS under a directory of this name rather than one that contains it.
 */
const ROOT_ONLY_EXCLUDED_DIRECTORY = '.claude'
/** The correct entry: excludes the project's own `.claude`, wherever the project itself lives. */
const ANCHORED_EXCLUSION = `!${ROOT_ONLY_EXCLUDED_DIRECTORY}`
/** The entry that caused #40, kept named so both tests can assert its absence rather than spell it twice. */
const UNANCHORED_EXCLUSION = `!**/${ROOT_ONLY_EXCLUDED_DIRECTORY}`

/**
 * The same glob as it appears in a config FILE rather than in a parsed array.
 *
 * The two tests below check different representations of one fact — one reads `files.includes` out of
 * parsed JSON, the other searches JSON-with-comments as text — and the quotes are what make the second
 * safe. Naming the conversion keeps both tests using the same two constants, instead of the text one
 * re-spelling them with quotes inline.
 */
function asConfiguredString(glob: string): string {
  return `"${glob}"`
}

/**
 * Directories that legitimately nest, so their exclusions must KEEP the leading globstar.
 *
 * Not an oversight that these differ from the one above: the generated monorepo layout declares a
 * `packages` workspace, so anchoring these would start linting a `node_modules` nested inside a package.
 * They share a shape with the bug and not its cause.
 *
 * Written without a nested glob path on purpose — the sequence that ends a block comment appears in one,
 * and putting it here silently terminated this comment and reformatted the code below it as an expression.
 */
const LEGITIMATELY_NESTED_EXCLUSIONS = ['node_modules', 'dist', 'coverage']

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

describe('the .claude exclusion', () => {
  it('is anchored to the config directory in the shipped config', async () => {
    // PARSED, not matched, because this file is real JSON and the strongest available check is to read the
    // actual array — a comment could not reach `files.includes`. See
    // `.claude/rules/asserting-on-file-content.md`.
    const shippedConfig = JSON.parse(await readFile(SHIPPED_BIOME_CONFIG_PATH, 'utf8')) as {
      files: { includes: string[] }
    }

    // WHY THIS IS GUARDED AT ALL. `!**/.claude` reads as the obvious form and is the bug (#40): Biome
    // matches it against the absolute path, so any checkout under a directory named `.claude` — which is
    // where worktrees conventionally live — excluded ITSELF entirely. Measured on Biome 2.5.6 as "Checked 0
    // files" and exit 1, for the factory and for a project generated under `~/.claude/`.
    //
    // Restoring the leading globstar is a small edit that looks like a tidy-up, which is exactly why it
    // needs a test rather than a comment.
    expect(shippedConfig.files.includes).toContain(ANCHORED_EXCLUSION)
    expect(
      shippedConfig.files.includes,
      `${UNANCHORED_EXCLUSION} excludes any tree that SITS under a ${ROOT_ONLY_EXCLUDED_DIRECTORY} directory, ` +
        'not just one containing it — a worktree or generated project there lints zero files. See #40.',
    ).not.toContain(UNANCHORED_EXCLUSION)

    // The distinction this guard exists to keep straight: these must NOT be anchored the same way.
    for (const nestedDirectory of LEGITIMATELY_NESTED_EXCLUSIONS) {
      expect(
        shippedConfig.files.includes,
        `"!${nestedDirectory}" would stop excluding packages/*/${nestedDirectory} in a workspace`,
      ).toContain(`!**/${nestedDirectory}`)
    }
  })

  it('is anchored the same way in the factory config that extends it', async () => {
    // MATCHED ON THE QUOTED FORM, not parsed, because `biome.jsonc` carries comments and a tolerant parser
    // is more machinery than this is worth. The quotes are the discriminator: this file's comments explain
    // both forms of the glob in prose and reference `.claude` repeatedly, so a bare-word search would match
    // the explanation as readily as the configuration. Comments here quote identifiers with backticks.
    //
    // Deliberately stricter than the format allows — a semantically equivalent entry spelled differently
    // fails this. That is the correct trade: a false positive fails loudly and is a one-line fix, where the
    // false negative it replaces is silent. Do not loosen it; loosening is what re-admits the prose.
    const factoryConfigContents = await readFile(FACTORY_BIOME_CONFIG_PATH, 'utf8')

    expect(factoryConfigContents).toContain(asConfiguredString(ANCHORED_EXCLUSION))
    expect(
      factoryConfigContents,
      'the factory config reintroduced the unanchored form, so its own gate cannot run from a worktree',
    ).not.toContain(asConfiguredString(UNANCHORED_EXCLUSION))
  })
})
