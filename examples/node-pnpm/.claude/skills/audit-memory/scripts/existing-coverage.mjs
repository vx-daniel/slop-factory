#!/usr/bin/env node
// Promotion-awareness signal for the memory auditor. In a corpus that has been audited
// before, some clusters are ALREADY promoted to rules or skills, and the memories often
// say so. Re-proposing shipped knowledge wastes review and risks contradicting the live
// rule. This reports two things the agent must consult before proposing any rule:
//
//   (A) the existing rule inventory — what `.claude/rules/` already covers, with scope flags
//   (B) per-memory promotion notes — memories that declare themselves (partly) promoted
//
// The agent uses these to propose only NET-NEW rules or UPDATES, never duplicates.

import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const INDEX_FILE_NAMES = ['MEMORY.md', 'MEMORY_CURRENT.md']

// Phrases a memory uses when it points at an existing rule/skill that already carries it.
const PROMOTION_PATTERNS = [
  /\.claude\/rules\//,
  /project-rule equivalent/i,
  /promoted to/i,
  /now (a )?rule/i,
  /the rule this guards/i,
  /covered by (the )?.*skill/i,
  /→\s*.*skill/i,
  /lives in `?\.claude/i
]

function resolveRepoRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  } catch {
    return process.cwd()
  }
}

function readFrontmatter(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---/)
  return match ? match[1] : ''
}

function firstHeading(contents) {
  const match = contents.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : '(no H1)'
}

function summarizeRule(fileName, contents) {
  const frontmatter = readFrontmatter(contents)
  const flags = []
  if (/^always_on:\s*true/m.test(frontmatter)) flags.push('always_on')
  if (/^paths:/m.test(frontmatter)) flags.push('path-scoped')
  if (/^trigger_phrase:/m.test(frontmatter)) flags.push('trigger_phrase')
  const scope = flags.length > 0 ? flags.join(', ') : 'unscoped'
  return { fileName, heading: firstHeading(contents), scope }
}

function scanForPromotionNotes(contents) {
  const hits = []
  contents.split('\n').forEach((line, lineIndex) => {
    if (PROMOTION_PATTERNS.some((pattern) => pattern.test(line))) {
      hits.push({ lineNumber: lineIndex + 1, text: line.trim() })
    }
  })
  return hits
}

function parseArguments(argv) {
  const args = { help: false, rulesDir: null, memoryDir: null }
  for (const token of argv.slice(2)) {
    if (token === '--help' || token === '-h') args.help = true
    else if (token.startsWith('--rules=')) args.rulesDir = token.slice('--rules='.length)
    else if (token.startsWith('--memory=')) args.memoryDir = token.slice('--memory='.length)
  }
  return args
}

function main() {
  const args = parseArguments(process.argv)
  if (args.help) {
    process.stdout.write(
      [
        'existing-coverage.mjs — what is already a rule, and which memories say they are promoted',
        '',
        'Usage: node existing-coverage.mjs [--rules=DIR] [--memory=DIR]',
        '',
        '  --rules=DIR   rules dir (default: <repo>/.claude/rules)',
        '  --memory=DIR  durable memory dir (default: <repo>/.claude/memory)',
        ''
      ].join('\n')
    )
    return
  }

  const repoRoot = resolveRepoRoot()
  const rulesDir = args.rulesDir ?? join(repoRoot, '.claude', 'rules')
  const memoryDir = args.memoryDir ?? join(repoRoot, '.claude', 'memory')

  process.stdout.write('(A) existing rule inventory — do NOT re-propose what these already cover\n\n')
  if (existsSync(rulesDir)) {
    const ruleFileNames = readdirSync(rulesDir).filter((fileName) => fileName.endsWith('.md'))
    for (const fileName of ruleFileNames) {
      const rule = summarizeRule(fileName, readFileSync(join(rulesDir, fileName), 'utf8'))
      process.stdout.write(`  ${rule.fileName}  [${rule.scope}]\n    ${rule.heading}\n`)
    }
  } else {
    process.stdout.write(`  (no rules dir at ${rulesDir})\n`)
  }

  process.stdout.write('\n(B) memories that declare themselves (partly) promoted — these clusters are\n')
  process.stdout.write('    likely UPDATE-or-skip, not net-new:\n\n')
  if (!existsSync(memoryDir)) {
    process.stderr.write(`ERROR: memory dir not found: ${memoryDir}\n`)
    process.exitCode = 1
    return
  }
  const memoryFileNames = readdirSync(memoryDir).filter(
    (fileName) => fileName.endsWith('.md') && !INDEX_FILE_NAMES.includes(fileName)
  )
  let promotedCount = 0
  for (const fileName of memoryFileNames) {
    const hits = scanForPromotionNotes(readFileSync(join(memoryDir, fileName), 'utf8'))
    if (hits.length === 0) continue
    promotedCount += 1
    process.stdout.write(`  ${fileName}\n`)
    for (const hit of hits) {
      process.stdout.write(`    L${hit.lineNumber}: ${hit.text}\n`)
    }
    process.stdout.write('\n')
  }
  process.stdout.write(`  ${promotedCount} of ${memoryFileNames.length} memories carry a promotion note.\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
