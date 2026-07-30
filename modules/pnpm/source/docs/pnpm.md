# Using pnpm

This project uses **pnpm** as its package manager, and therefore **Node** as its runtime. See
`node-runtime.md` in this folder for the runtime half — the Node version floor, tsx, and the mandatory
`.js` extension. This document covers only what is specific to pnpm.

`pnpm-lock.yaml` is the committed lockfile. Every other manager's is gitignored.

## The strict store, and why installs can fail here that pass under npm

npm and Bun install a **flat** `node_modules`: every transitive dependency is hoisted to the top level.
pnpm does not. It keeps one content-addressed store and builds `node_modules` out of symlinks, so a
package can only see what its own `package.json` declares.

The practical consequence is the one that surprises people:

```ts
import { something } from 'a-package-you-never-installed.js'
```

Under npm this resolves, as long as *some* dependency of yours happens to depend on it. Under pnpm it
fails. The pattern is called a **phantom dependency**, and npm's tree hides it until the day that other
package drops the dependency.

**So an install that succeeds under npm can fail under pnpm, and that is pnpm working correctly.** The
fix is always the same: add the package it names to `package.json`. Do not reach for
`node-linker=hoisted` or `shamefully-hoist` to make the error go away — that restores the flat tree and
with it the class of bug you would be re-hiding.

## `pnpm install --frozen-lockfile` in CI

`--frozen-lockfile` is pnpm's equivalent of `npm ci`: it fails when `pnpm-lock.yaml` and `package.json`
disagree, instead of silently resolving a different tree and rewriting the lockfile inside the runner.
Without it, CI can pass against dependency versions nobody has installed and nothing has recorded.

Locally you want plain `pnpm install`, because adding a dependency is *supposed* to update the lockfile.

One difference from npm worth knowing: `--frozen-lockfile` is already the default when pnpm detects CI,
so `.github/workflows/ci.yml` states it explicitly rather than relying on that detection. Detection
depends on the `CI` environment variable being set, which is true on GitHub Actions and not guaranteed
anywhere else.

## CI step order is load-bearing

In `.github/workflows/ci.yml`, `pnpm/action-setup` runs **before** `actions/setup-node`. That order is
not cosmetic:

```yaml
- uses: pnpm/action-setup@v4      # must come first
  with:
    version: 10

- uses: actions/setup-node@v4
  with:
    node-version: '24'
    cache: pnpm                   # needs pnpm already on PATH
```

`cache: pnpm` asks setup-node to locate the pnpm store, which it does by running pnpm. If setup-node
runs first, pnpm is not yet installed and the step fails — reporting a **cache error**, which sends you
looking in the wrong place entirely. Do not reorder these two steps.

## Commit the lockfile, and only this one

`pnpm-lock.yaml` is committed. Never commit a second lockfile alongside it: two lockfiles for one
`package.json` resolve independently and drift, and nobody notices until a version differs between a
teammate's install and CI. `.gitignore` already excludes `package-lock.json`, `bun.lock`, `bun.lockb`,
and `yarn.lock` for that reason; leave those lines in place.

## Running binaries: `pnpm exec`, not `pnpm run`

`pnpm run <name>` runs a script from `package.json`. `pnpm exec <binary>` runs a binary from
`node_modules/.bin`. They are not interchangeable, and confusing them produces a confusing error —
`pnpm run vitest` reports a missing *script*, not a missing binary.

This is why `.github/workflows/coverage-main.yml` uses `pnpm exec vitest run --coverage`: it needs Vitest
itself, deliberately not the `coverage` script, because that script also regenerates `COVERAGE.md` and
would defeat the change detection in the step that follows.

`pnpm dlx` is the equivalent of `npx` for a package that is *not* installed.

## Switching back to npm

1. `rm -rf node_modules pnpm-lock.yaml`
2. `npm install`
3. Invert the `.gitignore` lockfile rules: commit `package-lock.json`, ignore `pnpm-lock.yaml`.
4. In `.github/workflows/ci.yml` and `coverage-main.yml`, drop the `pnpm/action-setup` step, set
   `cache: npm`, and change the install command to `npm ci` and `pnpm exec` to `npx`.

`scripts/gate.ts` needs no change; it detects its own package manager.
