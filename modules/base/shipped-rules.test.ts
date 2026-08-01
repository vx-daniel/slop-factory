import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the two claims in the shipped agent rules that can go stale WITHOUT anyone editing the rules.
 *
 * `modules/base/source/.claude/rules/` ships into every generated project and is loaded as authoritative
 * by agents and by the PR-review workflow. Its prose describes artifacts owned by OTHER modules — the
 * Biome config in `modules/gate/`, the memory scripts in this module's own `skills/` tree — so a change
 * over there silently falsifies a document over here. Both couplings below have already drifted once:
 *
 *   1. Rule files name Biome rules and their severities. Nothing tied those names to the config that
 *      actually sets them, so `useExplicitType` was documented as covering only exported functions and
 *      exempting all callbacks, neither of which the rule does.
 *   2. `agent-memory.md` mandates a header block for `MEMORY.md`, and `export-memory.mjs` declares its
 *      copy "MUST stay in sync" with it. They drifted anyway — the script gained `/ temp-support` and the
 *      rule did not.
 *
 * Both assertions read DATA, never prose, per `.claude/rules/asserting-on-file-content.md`: `biome.json`
 * is parsed as JSON (a comment cannot reach `linter.rules`), and the header comparison uses two delimited
 * forms — a fenced ```markdown block and a `const` template literal — that surrounding explanation cannot
 * produce.
 *
 * MUTATION-TESTED. Both were watched failing before this file was committed: flipping `useExplicitType`
 * to `error` in the shipped `biome.json` reddened the first, and changing one word inside
 * `DURABLE_INDEX_HEADER` reddened the second.
 */

const SHIPPED_BIOME_CONFIG_PATH = path.resolve(import.meta.dirname, '..', 'gate', 'source', 'biome.json')
const SHIPPED_RULES_DIRECTORY = path.join(import.meta.dirname, 'source', '.claude', 'rules')
const AGENT_MEMORY_RULE_PATH = path.join(SHIPPED_RULES_DIRECTORY, 'agent-memory.md')
const EXPORT_MEMORY_SCRIPT_PATH = path.join(
  import.meta.dirname,
  'source',
  '.claude',
  'skills',
  'sync-project-memory',
  'scripts',
  'export-memory.mjs',
)

/**
 * Every Biome rule the shipped rules name together with a severity, and the severity they claim.
 *
 * This table restates the documentation on purpose — it is the machine-readable half of a claim that
 * otherwise exists only as prose. When `biome.json` changes, this fails and the prose gets updated with
 * it. The completeness test below stops the table from silently falling behind the rule files.
 */
const DOCUMENTED_RULE_SEVERITIES: Record<string, string> = {
  noExplicitAny: 'error',
  noNestedTernary: 'error',
  noNonNullAssertion: 'error',
  noProcessEnv: 'error',
  noTsIgnore: 'error',
  useExhaustiveSwitchCases: 'error',
  useExplicitLengthCheck: 'error',
  useExplicitType: 'warn',
  useMaxParams: 'error',
  useNumericSeparators: 'error',
  useThrowNewError: 'error',
  useThrowOnlyError: 'error',
}

interface BiomeConfiguration {
  readonly linter: { readonly rules: Record<string, Record<string, string>> }
  readonly overrides: readonly {
    readonly includes: readonly string[]
    readonly linter: { readonly rules: Record<string, Record<string, string>> }
  }[]
}

/** Flattens Biome's group-keyed rule map (`style.noProcessEnv`) into `ruleName -> severity`. */
function severityByRuleName(ruleGroups: Record<string, Record<string, string>>): Record<string, string> {
  const flattened: Record<string, string> = {}
  for (const rulesInGroup of Object.values(ruleGroups)) {
    // `preset: "recommended"` sits alongside the groups as a plain string; skip anything not a group object.
    if (typeof rulesInGroup !== 'object') continue
    for (const [ruleName, severity] of Object.entries(rulesInGroup)) {
      flattened[ruleName] = severity
    }
  }
  return flattened
}

async function readShippedBiomeConfiguration(): Promise<BiomeConfiguration> {
  return JSON.parse(await readFile(SHIPPED_BIOME_CONFIG_PATH, 'utf8')) as BiomeConfiguration
}

/**
 * Collects every Biome rule name the rule files cite, by intersecting backticked identifiers found in the
 * prose with the rule names the shipped config actually configures.
 *
 * The intersection is what makes this safe to run over documented files: a rule file's comments and
 * examples are full of backticked identifiers, but only the ones Biome itself configures can match, so the
 * prose cannot inject a false positive.
 */
async function citedBiomeRuleNames(configuredRuleNames: readonly string[]): Promise<Set<string>> {
  const { readdir } = await import('node:fs/promises')
  const ruleFileNames = (await readdir(SHIPPED_RULES_DIRECTORY)).filter((fileName) => fileName.endsWith('.md'))
  const configuredRuleNameSet = new Set(configuredRuleNames)
  const citedRuleNames = new Set<string>()

  for (const ruleFileName of ruleFileNames) {
    const ruleFileContents = await readFile(path.join(SHIPPED_RULES_DIRECTORY, ruleFileName), 'utf8')
    for (const backtickedIdentifier of ruleFileContents.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)) {
      const identifier = backtickedIdentifier[1]
      if (identifier !== undefined && configuredRuleNameSet.has(identifier)) citedRuleNames.add(identifier)
    }
  }
  return citedRuleNames
}

/** Pulls the single fenced ```markdown block out of `agent-memory.md`. */
function fencedMarkdownBlockOf(ruleContents: string): string | undefined {
  return ruleContents.match(/```markdown\n([\s\S]*?)\n```/)?.[1]
}

/**
 * Pulls the `DURABLE_INDEX_HEADER` template literal out of the export script and unescapes its backticks.
 *
 * The character class stops at the first UNESCAPED backtick, which matters because the header's body is
 * full of `\``-escaped ones — a lazy `[\s\S]*?` would terminate on the first of those instead.
 */
function durableIndexHeaderOf(scriptContents: string): string | undefined {
  const literal = scriptContents.match(/const DURABLE_INDEX_HEADER = `((?:[^`\\]|\\[\s\S])*)`/)?.[1]
  return literal?.replaceAll('\\`', '`')
}

describe('the Biome severities the shipped rules document', () => {
  it('match the shipped biome.json exactly', async () => {
    // JSON.parse, not a substring search: `biome.json` is real JSON, so the severities are reachable as
    // data and the file's own explanatory content cannot satisfy this assertion.
    const configuredSeverities = severityByRuleName((await readShippedBiomeConfiguration()).linter.rules)

    for (const [ruleName, documentedSeverity] of Object.entries(DOCUMENTED_RULE_SEVERITIES)) {
      expect(
        configuredSeverities[ruleName],
        `the shipped rules document \`${ruleName}\` as "${documentedSeverity}", but biome.json sets it to ` +
          `"${configuredSeverities[ruleName]}". Update modules/base/source/.claude/rules/ to match the gate — ` +
          'a rule file that misstates its own gate teaches agents to trust the wrong threshold.',
      ).toBe(documentedSeverity)
    }
  })

  it('cover every Biome rule the rule files actually cite', async () => {
    // Without this, adding a severity claim to a rule file is invisible to the test above forever.
    const configuredSeverities = severityByRuleName((await readShippedBiomeConfiguration()).linter.rules)
    const citedRuleNames = await citedBiomeRuleNames(Object.keys(configuredSeverities))

    const uncoveredRuleNames = [...citedRuleNames].filter((ruleName) => !(ruleName in DOCUMENTED_RULE_SEVERITIES))
    expect(
      uncoveredRuleNames,
      'these Biome rules are named in the shipped rules but absent from DOCUMENTED_RULE_SEVERITIES, so ' +
        'nothing checks the severity claimed for them: ' +
        uncoveredRuleNames.join(', '),
    ).toEqual([])
  })

  it('describe the noProcessEnv source/test split the override actually implements', async () => {
    // `naming-and-style.md` states this split in prose ("off in source ... error in tests"). The override is
    // the only place it is real, and it is one edit away from silently inverting.
    const { overrides } = await readShippedBiomeConfiguration()
    const sourceOverride = overrides.find((override) => override.includes.includes('!**/*.test.ts'))

    expect(sourceOverride, 'no biome.json override excludes **/*.test.ts — the documented split is gone').toBeDefined()
    expect(sourceOverride?.linter.rules.style?.noProcessEnv).toBe('off')
  })
})

describe('the MEMORY.md durable header', () => {
  it('is identical in agent-memory.md and export-memory.mjs', async () => {
    // The script's constant is the source of truth — it is what writes the file. The rule reproduces it so
    // the convention is readable without opening the script, and `export-memory.mjs` says outright that the
    // two "MUST stay in sync". Nothing enforced that until this test; they had already drifted by one phrase.
    const [ruleContents, scriptContents] = await Promise.all([
      readFile(AGENT_MEMORY_RULE_PATH, 'utf8'),
      readFile(EXPORT_MEMORY_SCRIPT_PATH, 'utf8'),
    ])

    const documentedHeader = fencedMarkdownBlockOf(ruleContents)
    const writtenHeader = durableIndexHeaderOf(scriptContents)

    expect(documentedHeader, 'no fenced ```markdown block found in agent-memory.md').toBeDefined()
    expect(writtenHeader, 'no DURABLE_INDEX_HEADER template literal found in export-memory.mjs').toBeDefined()

    // trimEnd on both sides: the closing fence consumes the block's final newline, while the constant keeps
    // one because it is prepended to the index body. That single trailing newline is the only difference
    // allowed — every other character must match, wrapping included.
    expect(
      documentedHeader?.trimEnd(),
      'agent-memory.md and export-memory.mjs disagree about the durable MEMORY.md header. The script is ' +
        'authoritative (it writes the file); update the fenced block in the rule to match it verbatim.',
    ).toBe(writtenHeader?.trimEnd())
  })
})
