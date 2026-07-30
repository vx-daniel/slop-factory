import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Locates the COMPILED plopfile. The factory always runs its built output, never its TypeScript source.
 *
 * WHY THERE IS NO `.ts` FALLBACK. node-plop loads the plopfile with a bare dynamic `import()` of an
 * absolute path, which goes straight to Node's ESM loader — it never passes through tsx or Vitest's
 * transform, whatever is running above it. Node can strip the types, but it will not remap the `./x.js`
 * specifiers inside to their `.ts` siblings, so the first internal import fails with
 * `Cannot find module .../module-contract.js`. Those specifiers must stay `.js` because
 * `allowImportingTsExtensions` requires `noEmit`, and this package has to emit to be publishable.
 *
 * Running the built artifact everywhere turns that constraint into an advantage: `npm run generate` and
 * the test suites exercise byte-for-byte what `npx slop-factory` will run, rather than a source path
 * that only resembles it.
 *
 * Two locations, because this module is compiled into `dist/` alongside the plopfile:
 *
 *   - **From `dist/`** (published, and `npm run generate`): the plopfile is a sibling.
 *   - **From the repo root** (the test suites, loaded through Vitest's transform): it is under `dist/`.
 */
export function resolvePlopfilePath(): string {
  const siblingPlopfile = path.join(import.meta.dirname, 'plopfile.js')
  if (existsSync(siblingPlopfile)) {
    return siblingPlopfile
  }

  const builtPlopfile = path.join(import.meta.dirname, 'dist', 'plopfile.js')
  if (existsSync(builtPlopfile)) {
    return builtPlopfile
  }

  throw new Error(
    'could not find the compiled plopfile. Run `npm run build` first — the factory runs its built ' +
      'output, because node-plop imports the plopfile through Node directly and cannot resolve ' +
      'TypeScript sources.',
  )
}
