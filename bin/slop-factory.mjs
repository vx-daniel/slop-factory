#!/usr/bin/env node
/**
 * The `slop-factory` binary.
 *
 * Hand-written as plain JavaScript rather than compiled from TypeScript so the `#!` shebang is
 * guaranteed to survive verbatim. Whether tsc preserves a shebang is a detail of the emitter, and the
 * executable entry of a published CLI is not a place to depend on one.
 *
 * It loads the compiled CLI only — there is no TypeScript fallback, by design. Node refuses to strip
 * types under `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a published install must
 * run JavaScript; and node-plop imports the plopfile through Node's own loader, which cannot resolve
 * `.js` specifiers to `.ts` siblings. Running the build everywhere means development exercises exactly
 * what ships, instead of a second path that merely resembles it.
 *
 * All logic lives in `../dist/cli.js`; this file forwards arguments and sets the exit code.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const compiledEntry = path.join(import.meta.dirname, '..', 'dist', 'cli.js')

if (!existsSync(compiledEntry)) {
  process.stderr.write(
    'slop-factory: dist/cli.js not found.\n' +
      '  Working from a clone? Run `npm run build`.\n' +
      '  Installed from npm? The published package is missing its build output — please report it.\n',
  )
  process.exit(1)
}

const { runCommandLine } = await import(pathToFileURL(compiledEntry).href)

// argv[0] is the node binary and argv[1] is this script, so the user's arguments start at index 2.
//
// `process.exit` rather than setting `exitCode`: inquirer installs signal handlers and keeps stdin
// referenced, so an abandoned prompt can leave the event loop alive with a pending top-level await —
// Node then prints "Detected unsettled top-level await" over whatever message we just wrote. Exiting
// explicitly is what makes the cancellation path end cleanly.
process.exit(await runCommandLine(process.argv.slice(2)))
