#!/usr/bin/env node
/**
 * Removes `dist/` so each build produces it from scratch.
 *
 * WHY THIS EXISTS. Neither half of the build deletes anything. `tsc` overwrites the files it emits but
 * leaves output for sources that no longer exist, and `scripts/copy-dist-assets.ts` uses `cp`, which
 * overwrites without pruning. So `dist/` only ever grew, and a file deleted from `modules/` stayed in it
 * indefinitely.
 *
 * That is not cosmetic, for two reasons. `package.json` publishes the whole of `dist/`, so a deleted file
 * would keep shipping to consumers. Worse, the generator resolves module assets out of `dist/`, so a
 * verbatim `source/` file that was deleted and REPLACED by a rendered `.hbs` template lands twice — and
 * plop's `add` action refuses to overwrite, so generation fails outright with "File already exists".
 *
 * That is exactly how this was found: deleting the two per-runtime `ci.yml` files in favour of a single
 * rendered `modules/base/ci.yml.hbs` left both old copies in `dist/`, and every generation aborted.
 *
 * Written as a script rather than `rm -rf dist` in the npm script so the build works on Windows, where
 * that command does not exist.
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'

const FACTORY_ROOT = path.resolve(import.meta.dirname, '..')
const DIST_DIRECTORY = path.join(FACTORY_ROOT, 'dist')

// `force` so a first build, with no `dist/` yet, is not an error.
await rm(DIST_DIRECTORY, { recursive: true, force: true })

process.stdout.write('clean-dist: removed dist/\n')
