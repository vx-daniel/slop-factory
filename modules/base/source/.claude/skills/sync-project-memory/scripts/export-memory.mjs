#!/usr/bin/env node
// Export agent memories from the machine-local auto-memory dir into the committed in-repo
// memory dir (`.claude/memory/`), realizing the two-index split so the durable corpus is
// shareable AND the current-task corpus travels as an audit trail. The "export" half of the
// mind-meld.
//
//   feedback_* / user_* / reference_*  -> DURABLE  -> .claude/memory/        (+ MEMORY.md index)
//   project_*                          -> CURRENT  -> .claude/memory/temp/   (files) ; index at
//                                                     .claude/memory/MEMORY_CURRENT.md
//   anything else                      -> UNKNOWN  -> held + reported, never silently dropped
//
// Both indices (MEMORY.md, MEMORY_CURRENT.md) sit at the top of .claude/memory/. Current-task
// FILES are quarantined under temp/ — high-staleness, "for local working agents", NOT
// authoritative (the GitHub issue/PR each note cites is the shared source of task state). The CI
// reviewer reads only `.claude/memory/MEMORY.md`, never temp/. See .claude/rules/agent-memory.md.
//
// Still deferred: import (committed -> local) and the CI memory-hygiene reminder. (The auditor is
// the separate `audit-memory` skill.)
//
// Safe by default: prints a plan and writes nothing unless --write is passed.
// Non-destructive to the source dir in all modes.

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

// Durable index header — MUST stay in sync with .claude/rules/agent-memory.md. Re-asserted on
// every regen so a clobbered header self-heals. MEMORY_CURRENT.md is a sibling of this file.
const DURABLE_INDEX_HEADER = `# Memory Index — Durable

> **Two-index memory** (see \`.claude/rules/agent-memory.md\`). This file holds **durable**
> project knowledge shared with the whole team via the repo. **Current-task / feature /
> temp-support notes live in [\`MEMORY_CURRENT.md\`](./MEMORY_CURRENT.md)** — high-staleness
> working memory, not durable principle. Do not file durable knowledge there, and do not treat
> current-task notes as standing rules.
`

// Current index header — quarantine notice. The committed current corpus is an audit trail of
// in-flight work, NOT authoritative and NOT standing rules; the GitHub issue/PR is the shared
// source of task state. The CI reviewer is pointed at the durable MEMORY.md only, never here.
// This index lives at .claude/memory/MEMORY_CURRENT.md; the files it lists are under temp/.
const CURRENT_INDEX_HEADER = `# Memory Index — Current Task / Feature / Temp Support

> **High-staleness working memory** (see \`.claude/rules/agent-memory.md\`). These notes track
> in-flight tasks/features and are **targeted for local working agents** — NOT authoritative
> durable knowledge, and NOT standing rules. The shared, authoritative copy of task state is the
> GitHub issue/PR each note cites. The files live in \`temp/\`; retired when the task ships (git
> history keeps the record).
`

const DURABLE_PREFIXES = ['feedback_', 'user_', 'reference_']
const CURRENT_PREFIXES = ['project_']
const INDEX_FILE_NAMES = ['MEMORY.md', 'MEMORY_CURRENT.md']

function parseCommandLineArguments(argv) {
  const args = { write: false, help: false, source: null, dest: null }
  for (const token of argv.slice(2)) {
    if (token === '--write') args.write = true
    else if (token === '--help' || token === '-h') args.help = true
    else if (token.startsWith('--source=')) args.source = token.slice('--source='.length)
    else if (token.startsWith('--dest=')) args.dest = token.slice('--dest='.length)
  }
  return args
}

function resolveRepoRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
  } catch {
    return process.cwd()
  }
}

// The machine-local auto-memory dir is `~/.claude/projects/<encoded>/memory`, where
// <encoded> is the repo's absolute path with every `/` replaced by `-`.
function deriveLocalMemoryDir(repoRoot) {
  const encoded = repoRoot.replace(/\//g, '-')
  return join(homedir(), '.claude', 'projects', encoded, 'memory')
}

function classifyByPrefix(fileName) {
  if (DURABLE_PREFIXES.some((prefix) => fileName.startsWith(prefix))) return 'durable'
  if (CURRENT_PREFIXES.some((prefix) => fileName.startsWith(prefix))) return 'current'
  return 'unknown'
}

// Read the frontmatter `description:` as a fallback index hook when the source MEMORY.md
// has no curated line for a file. Handles both top-level and `metadata:`-nested shapes.
function extractFrontmatterDescription(fileContents) {
  const frontmatterMatch = fileContents.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return null
  const descriptionMatch = frontmatterMatch[1].match(/^\s*description:\s*"?(.+?)"?\s*$/m)
  return descriptionMatch ? descriptionMatch[1].trim() : null
}

// Map basename -> the existing curated index line from the source MEMORY.md, so regen
// preserves hand-tuned hooks rather than flattening to raw frontmatter.
function indexExistingHooks(sourceMemoryIndexPath) {
  const lineByFileName = new Map()
  if (!existsSync(sourceMemoryIndexPath)) return lineByFileName
  const lines = readFileSync(sourceMemoryIndexPath, 'utf8').split('\n')
  for (const line of lines) {
    const linkMatch = line.match(/\]\(([^)]+\.md)\)/)
    if (linkMatch) lineByFileName.set(basename(linkMatch[1]), line.trimEnd())
  }
  return lineByFileName
}

// linkPrefix points the index link at where the file is actually written: '' for durable
// (sibling of MEMORY.md), 'temp/' for current (files under temp/, index at the top level).
function buildIndexLine({ fileName, curatedLine, description, linkPrefix = '' }) {
  if (curatedLine) return curatedLine.replaceAll(`](${fileName})`, `](${linkPrefix}${fileName})`)
  const title = fileName.replace(/\.md$/, '')
  const hook = description ? ` — ${description}` : ''
  return `- [${title}](${linkPrefix}${fileName})${hook}`
}

// Regenerate an index file body (header + one line per memory file) from a sorted file list.
function buildIndex({ header, fileNames, sourceDir, curatedHooks, linkPrefix = '' }) {
  const indexLines = fileNames.map((fileName) =>
    buildIndexLine({
      fileName,
      curatedLine: curatedHooks.get(fileName),
      description: extractFrontmatterDescription(readFileSync(join(sourceDir, fileName), 'utf8')),
      linkPrefix
    })
  )
  return `${header}\n${indexLines.join('\n')}\n`
}

function main() {
  const args = parseCommandLineArguments(process.argv)
  if (args.help) {
    process.stdout.write(
      [
        'export-memory.mjs — export agent memories into the committed repo dir (two-index split)',
        '',
        'Usage: node export-memory.mjs [--write] [--source=DIR] [--dest=DIR]',
        '',
        '  (default)        dry-run: print the plan, write nothing',
        '  --write          apply: durable -> <dest>/ (+ MEMORY.md);',
        '                          current -> <dest>/temp/ files (+ <dest>/MEMORY_CURRENT.md index)',
        '  --source=DIR     override the machine-local memory dir (default: derived from repo path)',
        '  --dest=DIR       override the committed memory dir (default: <repo>/.claude/memory)',
        ''
      ].join('\n')
    )
    return
  }

  const repoRoot = resolveRepoRoot()
  const sourceDir = args.source ?? process.env.MEMORY_SOURCE_DIR ?? deriveLocalMemoryDir(repoRoot)
  const destDir = args.dest ?? join(repoRoot, '.claude', 'memory')
  const tempDir = join(destDir, 'temp')

  if (!existsSync(sourceDir)) {
    process.stderr.write(`ERROR: source memory dir not found: ${sourceDir}\n`)
    process.exitCode = 1
    return
  }

  const allFileNames = readdirSync(sourceDir).filter(
    (fileName) => fileName.endsWith('.md') && !INDEX_FILE_NAMES.includes(fileName)
  )

  const durableFileNames = []
  const currentFileNames = []
  const unknownFileNames = []
  for (const fileName of allFileNames) {
    const classification = classifyByPrefix(fileName)
    if (classification === 'durable') durableFileNames.push(fileName)
    else if (classification === 'current') currentFileNames.push(fileName)
    else unknownFileNames.push(fileName)
  }
  durableFileNames.sort()
  currentFileNames.sort()

  const curatedHooks = indexExistingHooks(join(sourceDir, 'MEMORY.md'))
  const durableIndex = buildIndex({ header: DURABLE_INDEX_HEADER, fileNames: durableFileNames, sourceDir, curatedHooks })
  // curatedHooks comes from the source MEMORY.md, which never lists project_* (current) files —
  // so it is always empty for current files and buildIndexLine falls back to frontmatter
  // description. (A future source-side MEMORY_CURRENT.md is not consulted here.)
  const currentIndex = buildIndex({
    header: CURRENT_INDEX_HEADER,
    fileNames: currentFileNames,
    sourceDir,
    curatedHooks,
    linkPrefix: 'temp/'
  })

  const mode = args.write ? 'WRITE' : 'DRY-RUN'
  process.stdout.write(`mind-meld export [${mode}]\n`)
  process.stdout.write(`  source: ${sourceDir}\n`)
  process.stdout.write(`  dest:   ${destDir}\n\n`)
  process.stdout.write(`  durable -> ${destDir}/ (+ MEMORY.md): ${durableFileNames.length}\n`)
  process.stdout.write(`  current -> ${destDir}/temp/ files (+ MEMORY_CURRENT.md index): ${currentFileNames.length}\n`)
  process.stdout.write(`  unknown -> held + flagged: ${unknownFileNames.length}\n`)
  if (unknownFileNames.length > 0) {
    process.stdout.write(`    ${unknownFileNames.join('\n    ')}\n`)
  }

  if (!args.write) {
    process.stdout.write('\n  (dry-run — nothing written. Re-run with --write to apply.)\n')
    return
  }

  mkdirSync(destDir, { recursive: true })
  for (const fileName of durableFileNames) {
    copyFileSync(join(sourceDir, fileName), join(destDir, fileName))
  }
  writeFileSync(join(destDir, 'MEMORY.md'), durableIndex)

  mkdirSync(tempDir, { recursive: true })
  for (const fileName of currentFileNames) {
    copyFileSync(join(sourceDir, fileName), join(tempDir, fileName))
  }
  // Current index sits beside MEMORY.md (top of .claude/memory/), linking into temp/.
  writeFileSync(join(destDir, 'MEMORY_CURRENT.md'), currentIndex)

  process.stdout.write(`\n  wrote ${durableFileNames.length} durable + MEMORY.md\n`)
  process.stdout.write(`  wrote ${currentFileNames.length} current files to temp/ + MEMORY_CURRENT.md\n`)
}

main()
