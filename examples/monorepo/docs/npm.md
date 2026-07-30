# Using npm

This project uses **npm** as its package manager, and therefore **Node** as its runtime. See
`node-runtime.md` in this folder for the runtime half — the Node version floor, tsx, and the mandatory
`.js` extension. This document covers only what is specific to npm.

`package-lock.json` is the committed lockfile. Every other manager's is gitignored.

## `npm ci` in CI, `npm install` locally

The two are not interchangeable, and the difference is the reason CI uses `ci`:

| | `npm install` | `npm ci` |
|---|---|---|
| Lockfile disagrees with `package.json` | Silently resolves a new tree and **rewrites the lockfile** | Fails |
| Existing `node_modules` | Reused and patched | Deleted first |
| Speed | Slower | Faster |

Only the first row really matters. With `npm install`, CI can pass against a dependency tree that no
developer has ever installed and that is not recorded anywhere — the lockfile gets rewritten inside the
runner and thrown away with it. `npm ci` turns that into a build failure, which is what you want: a
lockfile that disagrees with `package.json` is a mistake somebody needs to see.

Locally you want the opposite behaviour, because adding a dependency is *supposed* to update the
lockfile. So: `npm install` at your desk, `npm ci` in `.github/workflows/ci.yml`.

## Commit the lockfile, and only this one

`package-lock.json` is committed. This is not optional — `npm ci` refuses to run without it.

Never commit a second lockfile alongside it. Two lockfiles for one `package.json` resolve independently
and drift, and nobody notices until a version differs between a teammate's install and CI. `.gitignore`
already excludes `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, and `yarn.lock` for exactly that reason;
leave those lines in place.

## The phantom-dependency trap

npm installs a **flat** `node_modules`: every transitive dependency is hoisted to the top level. A
consequence worth knowing about is that this code compiles and runs fine —

```ts
import { something } from 'a-package-you-never-installed.js'
```

— as long as *some* dependency of yours depends on it. The import resolves because the package is
sitting at the top level. It is called a phantom dependency, and it breaks the day that other package
drops the dependency, or you switch to a manager that does not hoist.

npm has no way to prevent this. If it matters to you, that is the main practical argument for pnpm,
whose symlinked store makes such an import fail immediately rather than at some later date.

(There is no `pnpm.md` in this folder — these docs describe the manager this project was generated with,
so only one of them ships.)

## Switching to pnpm

Mechanically small:

1. `rm -rf node_modules package-lock.json`
2. `pnpm import` (converts `package-lock.json` to `pnpm-lock.yaml` — do this *before* step 1 if you want
   the resolved versions preserved), then `pnpm install`.
3. Invert the `.gitignore` lockfile rules: commit `pnpm-lock.yaml`, ignore `package-lock.json`.
4. In `.github/workflows/ci.yml`, add the `pnpm/action-setup` step **before** `actions/setup-node`, set
   `cache: pnpm`, and change the install command to `pnpm install --frozen-lockfile`.

Expect step 2 to surface missing dependencies that the flat tree was hiding. That is pnpm working
correctly, not a broken install — add the packages it names to `package.json`.

`scripts/gate.ts` needs no change; it detects its own package manager.
