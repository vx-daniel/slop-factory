import { spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_COPY_TREE_DIRECTORY_NAMES } from './module-contract.js'

/**
 * Guards that every path this repository's documents point at actually exists.
 *
 * WHY. A link that used to resolve is the quietest kind of wrong document: nothing renders differently until
 * someone clicks it, and by then they are looking for a file that moved two changes ago. `CLAUDE.md` records
 * one that shipped — "a worked example that pointed at a file deleted two changes earlier" — and #55 counts
 * the rest. Unlike the prose claims in that issue, this class is decidable, so it should not be costing
 * anyone a review pass.
 *
 * SCOPE IS THE FACTORY'S OWN DOCUMENTS. `modules/*` copy trees are excluded: their markdown ships to a
 * generated project and its links resolve THERE, against a tree this repository does not contain. `examples/`
 * is excluded for the same reason — it is generated output, already compared byte-for-byte by
 * `examples:check`.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. External URLs, which would make the suite depend on the network and
 * on other people's uptime. Anchors within a document, because resolving them means parsing headings, and no
 * anchor has yet gone wrong here — a check with no incident behind it is the speculative work #51 argues
 * against.
 */

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')

/**
 * Paths whose markdown is not about this repository. See the header.
 *
 * Only what git ALONE cannot decide. `node_modules`, `dist`, `coverage` and `.local` are excluded by being
 * untracked, which is why they are absent here — restating them would be a second copy of `.gitignore`, and
 * the copy is what goes wrong.
 */
const EXCLUDED_PATH_PATTERNS: readonly RegExp[] = [
  /^examples\//,
  // DERIVED, not restated. `vitest.config.ts` excludes the same trees from the unit project the same way,
  // for the same reason: adding a copy tree must extend every exclusion automatically, or the next one
  // starts resolving a generated project's links against the factory's own filesystem.
  ...MODULE_COPY_TREE_DIRECTORY_NAMES.map(
    (copyTreeName: string): RegExp => new RegExp(`^modules/[^/]+/${copyTreeName}/`),
  ),
]

/**
 * A markdown link's target: `[text](target)`.
 *
 * Only the parenthesised target, so a path mentioned in prose is not treated as a link — prose legitimately
 * names files that do not exist yet, or that exist only in a generated project.
 */
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)\)/g

/**
 * Every markdown file this repository TRACKS, minus the trees whose links resolve elsewhere.
 *
 * Asked of git rather than walked, so `.gitignore` is the single definition of what belongs to this
 * repository. A hand-rolled walk needed its own exclusion list and got it wrong on the first run: it read a
 * generated `COVERAGE.md` under the untracked `.local/` and reported a broken link in a file nobody
 * committed. Deriving the set removes that whole category, and removes a second copy of `.gitignore` — the
 * copy being exactly what the convention in `CLAUDE.md` warns against.
 */
function findFactoryMarkdownFiles(): string[] {
  const tracked = spawnSync('git', ['ls-files', '*.md'], { cwd: FACTORY_ROOT, encoding: 'utf8' })
  if (tracked.status !== 0) {
    throw new Error(`git ls-files failed:\n${tracked.stderr}`)
  }
  return tracked.stdout
    .split('\n')
    .filter((trackedPath) => trackedPath !== '')
    .filter((trackedPath) => !EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(trackedPath)))
}

/** Whether a link target is one this check can decide. External URLs and bare anchors are not. */
function isCheckableTarget(linkTarget: string): boolean {
  return !/^(?:https?:|mailto:|#)/.test(linkTarget)
}

/** The file part of a link target, dropping any `#anchor`. Empty when the target is only an anchor. */
function filePartOf(linkTarget: string): string {
  const [filePath] = linkTarget.split('#')
  return filePath ?? ''
}

/** The targets in one document that point at nothing, reported as `document → target`. */
async function findBrokenLinksIn(markdownFile: string): Promise<string[]> {
  const contents = await readFile(path.join(FACTORY_ROOT, markdownFile), 'utf8')
  const documentDirectory = path.dirname(path.join(FACTORY_ROOT, markdownFile))
  const brokenLinks: string[] = []

  for (const [, linkTarget] of contents.matchAll(MARKDOWN_LINK_PATTERN)) {
    if (linkTarget === undefined || !isCheckableTarget(linkTarget)) {
      continue
    }
    // An anchor on a real file is fine; the FILE is what this resolves.
    const filePath = filePartOf(linkTarget)
    if (filePath === '') {
      continue
    }
    const targetExists = await access(path.resolve(documentDirectory, filePath))
      .then(() => true)
      .catch(() => false)
    if (!targetExists) {
      brokenLinks.push(`${markdownFile} → ${linkTarget}`)
    }
  }

  return brokenLinks
}

describe('every path the factory documents', () => {
  it('resolves to something that exists', async () => {
    const markdownFiles = findFactoryMarkdownFiles()

    // Guards the guard: a mis-resolved root or an over-broad exclusion would iterate nothing and pass.
    expect(markdownFiles.length, 'no markdown found — is the walk still correct?').toBeGreaterThan(0)

    const brokenLinks = (await Promise.all(markdownFiles.map(findBrokenLinksIn))).flat()

    expect(brokenLinks, 'these documents link to paths that do not exist').toEqual([])
  })
})
