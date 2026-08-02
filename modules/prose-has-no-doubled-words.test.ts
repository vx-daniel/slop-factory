import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards against the doubled word an edit leaves behind when it deletes the word between two others.
 *
 * WHY THIS EXISTS, and it is a defect this repository shipped rather than a hypothetical. Deleting the word
 * "three" from a phrase naming the JSON configs left its article stranded beside the article that followed,
 * in two files at once, and both reached a pull request. Nothing could see them: Biome formats code and does not read prose, `tsc` does not read
 * comments, and `examples:check` compares generated output rather than the factory's own text. Review caught
 * them, which is the mechanism #55 exists to stop relying on for decidable classes.
 *
 * It is decidable, which is the whole argument for spending a test on it. No judgement, no allowlist of
 * phrasings, no false positives to triage — a word repeated immediately after itself is a typo in every
 * context this repository writes.
 *
 * SCOPED WIDER THAN THE LINK CHECK, deliberately, and the difference is worth stating because the two files
 * sit beside each other. `documented-paths-resolve.test.ts` skips module copy trees because their links
 * resolve in a GENERATED project, against a tree this repository does not contain. A doubled word has no
 * such excuse: copy-tree prose is authored here and shipped verbatim, so a typo there reaches every adopter.
 * `examples/` is still skipped — it is generated from those same trees, so including it would report every
 * finding twice and point at the copy nobody should edit.
 *
 * NOTHING BELOW QUOTES AN EXAMPLE OF WHAT IT DETECTS, which is why this comment describes the defect rather
 * than showing it. The check reads its own file, and on the first run against a real tree it failed on five
 * illustrations in this very docstring. Excluding itself was the alternative and is worse: the one file
 * whose purpose is finding these would be the only one where a real occurrence could hide.
 */

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')

/** Generated output. A finding here is a finding in the module that produced it — reported there instead. */
const EXCLUDED_PATH_PATTERN = /^examples\//

/**
 * The words worth checking for repetition.
 *
 * A closed list of function words rather than "any word twice". Prose repeats a content word legitimately
 * more often than one might guess — a repeated identifier, a table cell, a quoted filename — while a
 * repeated article is never intended. Narrow and certain beats broad and argued-with, because a check that
 * needs its findings triaged is a check people learn to skip.
 */
const REPEATABLE_FUNCTION_WORDS = [
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'for',
  'is',
  'it',
  'that',
  'this',
  'with',
  'as',
  'be',
  'from',
  'not',
]

/**
 * Matches one of those words repeated, across a single space or a line break.
 *
 * The line break matters: this repository wraps prose at about 110 characters, so the likeliest place for a
 * doubled word to hide is either side of a wrap, where the eye is least likely to catch it.
 */
const DOUBLED_WORD_PATTERN = new RegExp(`\\b(${REPEATABLE_FUNCTION_WORDS.join('|')})\\s+\\1\\b`, 'gi')

/** Every markdown and TypeScript file this repository tracks, minus generated output. */
function findAuthoredTextFiles(): string[] {
  const tracked = spawnSync('git', ['ls-files', '*.md', '*.ts'], { cwd: FACTORY_ROOT, encoding: 'utf8' })
  if (tracked.status !== 0) {
    throw new Error(`git ls-files failed:\n${tracked.stderr}`)
  }
  return tracked.stdout
    .split('\n')
    .filter((trackedPath) => trackedPath !== '')
    .filter((trackedPath) => !EXCLUDED_PATH_PATTERN.test(trackedPath))
}

/** The doubled words in one file, reported as the path, the line, and the offending pair. */
async function findDoubledWordsIn(textFile: string): Promise<string[]> {
  const contents = await readFile(path.join(FACTORY_ROOT, textFile), 'utf8')
  const findings: string[] = []

  for (const match of contents.matchAll(DOUBLED_WORD_PATTERN)) {
    // Reported with a line number because the whole point is to find it again quickly; a bare filename
    // sends the reader hunting through a file whose prose is deliberately dense.
    const lineNumber = contents.slice(0, match.index).split('\n').length
    findings.push(`${textFile}:${lineNumber} → ${JSON.stringify(match[0])}`)
  }

  return findings
}

describe('the factory writes no doubled words', () => {
  it('has none in any authored markdown or TypeScript', async () => {
    const textFiles = findAuthoredTextFiles()

    // Guards the guard: a mis-resolved root or an over-broad exclusion would scan nothing and pass, which
    // for a check that is green on a healthy tree is indistinguishable from working.
    expect(textFiles.length, 'no authored text found — is the file list still correct?').toBeGreaterThan(0)

    const doubledWords = (await Promise.all(textFiles.map(findDoubledWordsIn))).flat()

    expect(doubledWords, 'these look like an edit that deleted a word and left its neighbour behind').toEqual([])
  })
})
