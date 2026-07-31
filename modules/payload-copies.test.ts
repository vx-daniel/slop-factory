import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards every file the factory uses at its own root that is a COPY of something it ships.
 *
 * These exist because the factory dogfoods its own output: it lints with the Biome config it prescribes and
 * runs the pull-request review it prescribes. In both cases the payload file is the authoritative one — it is
 * what adopters actually receive — and the factory's copy has to track it exactly.
 *
 * WHY COPIES AND NOT REFERENCES. Each has a specific reason the obvious approach does not work:
 *
 *   .biome/naming.grit — `biome.jsonc` extends the payload config, and `extends` inherits
 *     `plugins: ["./.biome/naming.grit"]` resolved against the EXTENDING file's directory rather than the
 *     base's. Measured on Biome 2.5.6: pointing it at the payload path fails with "Cannot read file" however
 *     the path is written.
 *
 *   .github/workflows/claude-pr-review.yml — GitHub only runs workflows from `.github/workflows/` at a
 *     repository root. A workflow living under `modules/` is not a workflow, it is a text file.
 *
 * A symlink would avoid the duplication in both cases and is deliberately not used: git symlinks need
 * `core.symlinks` on Windows, and this repository already went out of its way to keep the build portable
 * (`scripts/clean-dist.ts` exists rather than `rm -rf`). A guarded copy is the honest trade — duplication is
 * acceptable here precisely because it cannot drift silently, which is the standard the rest of the
 * repository is held to.
 */

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')

interface PayloadCopy {
  /** Path at the factory root, relative to it. */
  readonly factoryPath: string
  /** The payload file it must match. Authoritative, because adopters receive this one. */
  readonly payloadPath: string
  /** Why the factory cannot simply reference the payload file — surfaced in the failure message. */
  readonly whyCopied: string
}

const PAYLOAD_COPIES: readonly PayloadCopy[] = [
  {
    factoryPath: '.biome/naming.grit',
    payloadPath: 'modules/gate/source/.biome/naming.grit',
    whyCopied:
      'biome.jsonc extends the payload config, and the inherited plugin path resolves against the extending file',
  },
  {
    factoryPath: '.github/workflows/claude-pr-review.yml',
    payloadPath: 'modules/claude-workflows/source/.github/workflows/claude-pr-review.yml',
    whyCopied: 'GitHub only runs workflows from .github/workflows/ at a repository root',
  },
  {
    factoryPath: '.github/workflows/secret-scan.yml',
    payloadPath: 'modules/base/source/.github/workflows/secret-scan.yml',
    whyCopied: 'GitHub only runs workflows from .github/workflows/ at a repository root',
  },
]

describe('files the factory copies from its own payload', () => {
  it.each(PAYLOAD_COPIES)('$factoryPath matches $payloadPath byte for byte', async (payloadCopy) => {
    const [factoryContents, payloadContents] = await Promise.all([
      readFile(path.join(FACTORY_ROOT, payloadCopy.factoryPath), 'utf8'),
      readFile(path.join(FACTORY_ROOT, payloadCopy.payloadPath), 'utf8'),
    ])

    expect(
      factoryContents,
      `${payloadCopy.factoryPath} has drifted from ${payloadCopy.payloadPath}.\n` +
        `It is a copy because ${payloadCopy.whyCopied}.\n` +
        'The PAYLOAD file is authoritative — it is what adopters receive. Copy it over the factory one ' +
        'rather than reconciling by hand, then re-run.',
    ).toBe(payloadContents)
  })

  it('covers every copy, so the list cannot quietly fall behind', () => {
    // A guard whose list is empty passes. This makes that state fail instead, and pins the count so adding a
    // third copy is a deliberate edit here rather than an omission nothing notices.
    expect(PAYLOAD_COPIES.length, 'no payload copies declared — did the list get emptied?').toBe(3)
  })
})
