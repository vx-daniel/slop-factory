# Publishing

> **Not publish-ready yet** — see [#4](https://github.com/vx-daniel/slop-factory/issues/4) for the
> metadata that has to land first.

The published package is **only** `bin/`, `dist/`, and the README. `files` is an allowlist, so anything not
named is absent from the tarball.

```bash
npm publish   # prepublishOnly: check:all → test:prompts → test:layout → test:packaging
              #                 → examples:check → verify
```

## The factory always runs its built output, never its TypeScript source

Including in development. That is not a preference; two independent constraints force it, and both were
measured:

1. **Node refuses to strip types under `node_modules`.** It throws
   `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` by design, so that packages ship JavaScript instead of
   making every consumer pay a transform cost. An `npx` install lands in `node_modules`, so publishing
   `.ts` cannot work at any consumer Node version.
2. **node-plop imports the plopfile through Node's own loader.** It does a bare dynamic `import()` of an
   absolute path, bypassing tsx and Vitest's transform whatever is running above it. Node will not remap
   the `./x.js` specifiers inside to their `.ts` siblings, and those specifiers must stay `.js` because
   `allowImportingTsExtensions` requires `noEmit`.

Running the build everywhere turns that constraint into an advantage: `npm run generate` and the test
suites exercise byte-for-byte what `npx slop-factory` runs, rather than a second path that resembles it.

It is also why several npm scripts start with `npm run build`, and why `plopfile-path.ts` throws a message
naming the missing build rather than failing obscurely mid-generation.

## The build has three steps, and each exists for a reason

1. **`scripts/clean-dist.ts`** removes `dist/` outright.
2. **`tsc -p tsconfig.build.json`** compiles the factory's own code into `dist/`, mirroring the repo layout
   (`plopfile.ts` → `dist/plopfile.js`, `modules/base/module.ts` → `dist/modules/base/module.js`).
3. **`scripts/copy-dist-assets.ts`** copies each module's copy trees (`source/`, `packageSource/`) and its
   `.hbs` templates into `dist/modules/<name>/`.

### Why step 1 exists

Neither of the other two deletes anything. `tsc` overwrites what it emits but leaves output for sources
that no longer exist, and the copier uses `cp`, which overwrites without pruning. So `dist/` only ever
grew, and a file deleted from `modules/` stayed in it indefinitely.

That is not cosmetic. `files` publishes the whole of `dist/`, so a deleted file kept shipping to consumers.
Worse, the generator resolves module assets **out of `dist/`**, so a verbatim file that was deleted and
replaced by a rendered template landed twice — and plop's `add` action refuses to overwrite, so generation
aborted outright with `File already exists`.

That is exactly how it was found: replacing two per-manager `ci.yml` files with one rendered template left
both old copies in `dist/`, and every generation failed.

### Why step 3 exists

A module's copy trees are **payload, not code** — copied byte-for-byte into generated projects, and several
of those files are `.ts` that must *remain* `.ts` because they are the generated project's own source.
Compiling them would be exactly wrong.

Mirroring the layout inside `dist/` is what lets the plopfile resolve `modules/<name>/<tree>` relative to
its own directory unchanged, with no "am I built?" branch anywhere in the generator.

## What guards the tarball

**`tests/packaging.test.ts`**, because every other test runs against the working tree where every file is
present by definition. A `files` entry omitted, or an ignore rule swallowing a template, produces a package
that installs cleanly and fails at the consumer's first `generate`.

It asserts the CLI entry points, every module's compiled descriptor and document, the dot-path assets, the
`packageSource/` tree, that no uncompiled source or test file leaked in, and **every rendered template the
modules declare**.

That last one is derived from `renderedTemplates()` across every reachable answer set rather than listed.
It used to be a hardcoded array of five base filenames, which made the test's own name false the moment a
template was added — and its hardcoded `dist/modules/base/` prefix meant a non-base module's template could
not have been checked even if someone had remembered. Two templates reached a tarball unnoticed that way.
There are ten now, and a new one is covered without anyone remembering.

The union across answer sets matters because a module may decline to emit for some answers — `vitest`
returns no `coverage-main.yml` under Bun — so no single combination sees them all.

## The pack-filter trap

Guarded separately in `modules/module-sources.test.ts`: **npm honours `.gitignore` / `.npmignore` files
anywhere inside a package as pack filters.**

A `modules/base/source/.codegraph/.gitignore` containing `*` used to exist, and `npm pack --dry-run`
confirmed it excluded a sibling file from the tarball. It was harmless there and has been deleted (the
generated root `.gitignore` already ignores `.codegraph/` entirely), but the same pattern one directory
higher would ship a silently broken package.

A generated project's `.gitignore` comes from a rendered template outside any copy tree, which is where
such a file belongs. The guard scans **every** copy tree, and asserts at least one module ships each — a
check that passes because it found nothing to look at is not a check.

## Related

- [`verification.md`](verification.md) — the six suites and what each proves
- [`module-contract.md`](module-contract.md) — what a copy tree is, and why it is never rendered
