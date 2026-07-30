#!/usr/bin/env node
// Currency signal for the memory auditor. Before distilling a cluster of memories into a
// rule, you MUST know which members are stale or superseded — distilling across a
// self-superseding cluster bakes a *reverted* decision into an always-on rule, the
// highest-risk silent failure of the whole exercise.
//
// The robust signal is supersession LANGUAGE in the content (it travels with the files,
// unlike fs mtime which a git checkout resets). This scans the committed durable corpus for
// that language and reports each hit with its line, so the agent currency-gates before
// trusting any cluster. Last-commit date is shown as a weak secondary hint only.

import { execSync, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Phrases the corpus actually uses when a memory supersedes earlier guidance (in place or
// across files). Tuned to real hits: "OVERTURNED ASSUMPTION", "has been superseded",
// "Previously this memory said … no longer true", "treat that as stale".
const SUPERSESSION_PATTERNS = [
  /superseded/i,
  /overturned/i,
  /no longer (true|the case|valid|holds)/i,
  /\bstale\b/i,
  /\breverted\b/i,
  /\bobsolete\b/i,
  /deprecat/i,
  /previously this (memory|said|rule)/i,
  /this (memory|rule) (now )?(replaces|supersedes)/i
]

const INDEX_FILE_NAMES = ['MEMORY.md', 'MEMORY_CURRENT.md']

function resolveRepoRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  } catch {
    return process.cwd()
  }
}

function lastCommitDate(fileName, sourceDir) {
  try {
    const isoDate = execFileSync('git', ['log', '-1', '--format=%cs', '--', join(sourceDir, fileName)], {
      encoding: 'utf8'
    }).trim()
    return isoDate || '(uncommitted)'
  } catch {
    return '(unknown)'
  }
}

function scanForSupersessionLanguage(contents) {
  const hits = []
  contents.split('\n').forEach((line, lineIndex) => {
    if (SUPERSESSION_PATTERNS.some((pattern) => pattern.test(line))) {
      hits.push({ lineNumber: lineIndex + 1, text: line.trim() })
    }
  })
  return hits
}

function parseArguments(argv) {
  const args = { help: false, source: null }
  for (const token of argv.slice(2)) {
    if (token === '--help' || token === '-h') args.help = true
    else if (token.startsWith('--source=')) args.source = token.slice('--source='.length)
  }
  return args
}

function main() {
  const args = parseArguments(process.argv)
  if (args.help) {
    process.stdout.write(
      [
        'scan-currency.mjs — flag stale/superseded memories before distilling',
        '',
        'Usage: node scan-currency.mjs [--source=DIR]',
        '',
        '  --source=DIR  memory dir to scan (default: <repo>/.claude/memory).',
        '                Point at the machine-local dir for meaningful fs ages; the',
        '                committed corpus shares one import-commit date.',
        ''
      ].join('\n')
    )
    return
  }

  const sourceDir = args.source ?? join(resolveRepoRoot(), '.claude', 'memory')
  if (!existsSync(sourceDir)) {
    process.stderr.write(`ERROR: memory dir not found: ${sourceDir}\n`)
    process.exitCode = 1
    return
  }

  const fileNames = readdirSync(sourceDir).filter(
    (fileName) => fileName.endsWith('.md') && !INDEX_FILE_NAMES.includes(fileName)
  )

  const flagged = []
  for (const fileName of fileNames) {
    const hits = scanForSupersessionLanguage(readFileSync(join(sourceDir, fileName), 'utf8'))
    if (hits.length > 0) flagged.push({ fileName, hits })
  }

  process.stdout.write(`currency scan — ${sourceDir}\n`)
  process.stdout.write(`  ${fileNames.length} memories scanned, ${flagged.length} carry supersession language\n\n`)

  if (flagged.length === 0) {
    process.stdout.write('  No supersession language found. Still read each cluster — language is a\n')
    process.stdout.write('  signal, not a guarantee; an in-place rewrite leaves no marker.\n')
    return
  }

  process.stdout.write('FLAGGED — currency-gate these before distilling their cluster:\n\n')
  for (const entry of flagged) {
    process.stdout.write(`  ${entry.fileName}  (last commit ${lastCommitDate(entry.fileName, sourceDir)})\n`)
    for (const hit of entry.hits) {
      process.stdout.write(`    L${hit.lineNumber}: ${hit.text}\n`)
    }
    process.stdout.write('\n')
  }
  process.stdout.write(
    'These memories declare their own evolution. Read them in full and identify the CURRENT\n' +
      'truth before any member of their cluster feeds a rule. Never average across them.\n'
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
