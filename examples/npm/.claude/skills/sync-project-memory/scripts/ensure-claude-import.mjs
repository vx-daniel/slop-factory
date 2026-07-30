#!/usr/bin/env node
// Ensure CLAUDE.md imports the committed durable memory index, so the corpus auto-loads
// in every session — local sessions AND the CI PR reviewer both load CLAUDE.md. This
// closes the "read path" of the agent-memory mind-meld: export-memory.mjs *stages* the
// corpus; this wires it so something actually loads it.
//
// Idempotent: if the @import is already present, it is a no-op. Safe to run on every
// setup, after every export, or from a future SessionStart hook.

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const IMPORT_LINE = '@.claude/memory/MEMORY.md'

// Canonical section inserted when the import is missing. Mirrors the section in CLAUDE.md.
// Idempotency keys on IMPORT_LINE, so re-running never duplicates even if the prose drifts.
const MEMORY_SECTION = `## Agent Memory

This repo carries **committed agent memory** — durable, cross-session knowledge (receipts discipline, wire/firmware contract, test conventions) that lives with the code instead of in one machine's local Claude Code memory. The durable index is imported here so every session — including the CI PR reviewer, which loads \`CLAUDE.md\` — loads it:

${IMPORT_LINE}

How memory is organized and synced (the two-index durable/current split, the \`sync-project-memory\` skill) is governed by \`.claude/rules/agent-memory.md\`.`

function resolveRepoRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  } catch {
    return process.cwd()
  }
}

// Insert the memory section before the first `## ` heading so it reads as the opening
// section; if the file has no `## ` heading, append it at the end.
function insertMemorySection(existingContent) {
  const lines = existingContent.split('\n')
  const firstSectionIndex = lines.findIndex((line) => /^##\s/.test(line))
  if (firstSectionIndex === -1) {
    return `${existingContent.replace(/\s*$/, '')}\n\n${MEMORY_SECTION}\n`
  }
  const beforeSection = lines.slice(0, firstSectionIndex).join('\n').replace(/\s*$/, '')
  const fromSection = lines.slice(firstSectionIndex).join('\n')
  return `${beforeSection}\n\n${MEMORY_SECTION}\n\n${fromSection}`
}

/**
 * Ensure CLAUDE.md contains the committed-memory @import. Idempotent.
 * @param {{ claudeMdPath: string, write: boolean }} options
 * @returns {{ status: 'present' | 'inserted' | 'would-insert' | 'created' | 'would-create', path: string }}
 */
export function ensureClaudeImport(options) {
  const { claudeMdPath, write } = options
  if (!existsSync(claudeMdPath)) {
    if (write) writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${MEMORY_SECTION}\n`)
    return { status: write ? 'created' : 'would-create', path: claudeMdPath }
  }
  const content = readFileSync(claudeMdPath, 'utf8')
  if (content.includes(IMPORT_LINE)) {
    return { status: 'present', path: claudeMdPath }
  }
  if (write) writeFileSync(claudeMdPath, insertMemorySection(content))
  return { status: write ? 'inserted' : 'would-insert', path: claudeMdPath }
}

function parseArguments(argv) {
  const args = { write: false, help: false, claudeMdPath: null }
  for (const token of argv.slice(2)) {
    if (token === '--write') args.write = true
    else if (token === '--help' || token === '-h') args.help = true
    else if (token.startsWith('--claude-md=')) {
      const value = token.slice('--claude-md='.length)
      if (value.length > 0) args.claudeMdPath = value
    }
  }
  return args
}

function main() {
  const args = parseArguments(process.argv)
  if (args.help) {
    process.stdout.write(
      [
        'ensure-claude-import.mjs — ensure CLAUDE.md imports the committed durable memory index',
        '',
        'Usage: node ensure-claude-import.mjs [--write] [--claude-md=PATH]',
        '',
        '  (default)         dry-run: report present/missing, write nothing',
        '  --write           insert the Agent Memory section if the @import is missing (idempotent)',
        '  --claude-md=PATH  override CLAUDE.md path (default: <repo root>/CLAUDE.md)',
        ''
      ].join('\n')
    )
    return
  }
  const claudeMdPath = args.claudeMdPath ?? join(resolveRepoRoot(), 'CLAUDE.md')
  const result = ensureClaudeImport({ claudeMdPath, write: args.write })
  const messageByStatus = {
    present: 'already present — no change',
    inserted: 'was missing — inserted the Agent Memory section',
    'would-insert': 'MISSING — re-run with --write to insert',
    created: 'CLAUDE.md did not exist — created it with the Agent Memory section',
    'would-create': 'CLAUDE.md does not exist — re-run with --write to create it'
  }
  process.stdout.write(`ensure @import: ${messageByStatus[result.status]}\n  ${result.path}\n`)
}

// Run as a script only when invoked directly, not when imported elsewhere.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
