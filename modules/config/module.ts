import type { PackageJsonFragment, ProjectAnswers, ProjectModule } from '../module-contract.js'

const SMOL_TOML_VERSION = '^1.7.1'
const ZOD_VERSION = '^4.4.3'

/** The `enableFeatures` checkbox value that selects this module. */
export const CONFIG_FEATURE_VALUE = 'config'

/**
 * The layered-configuration module — opt-in via the `config` feature checkbox.
 *
 * Ships three layers with one job each: `config.defaults.toml` (committed, safe defaults),
 * `config.local.toml` (gitignored machine overrides), and `.env` (secrets only). The first two
 * deep-merge key by key and validate together against a strict Zod schema; the third never enters
 * the config object at all, because secrets are referenced BY VARIABLE NAME and read at the point of
 * use. That indirection is what makes the committed TOML safe to share.
 *
 * `zod` and `smol-toml` are `dependencies`, NOT `devDependencies`, and the distinction is real:
 * config loading happens at RUNTIME, so both ship to whatever the project deploys to. Everything
 * else the factory contributes (Biome, TypeScript, Vitest, tsx) is build- or test-time only.
 */
export const configModule: ProjectModule = {
  name: 'config',

  documentation: {
    path: 'docs/configuration.md',
    title: 'Configuration',
    summary: 'The three layers, key-by-key merging, and why secrets are referenced by name.',
  },

  isSelected(answers: ProjectAnswers): boolean {
    return answers.enableFeatures.includes(CONFIG_FEATURE_VALUE)
  },

  templateData(): Readonly<Record<string, unknown>> {
    return { hasConfigModule: true }
  },

  packageJsonFragment(): PackageJsonFragment {
    return {
      dependencies: {
        'smol-toml': SMOL_TOML_VERSION,
        zod: ZOD_VERSION,
      },
    }
  },
}
