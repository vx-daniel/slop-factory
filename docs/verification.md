# Verification

The suites, ordered cheap-first. The split is deliberate: bundling fast checks behind slow ones means
nobody runs either.

| Suite | Command | Cost | What it proves |
|---|---|---|---|
| unit | `npm test` | ms | merge/render logic, registry invariants, copy-tree guards |
| prompts | `npm run test:prompts` | ~2s | the prompt list matches the contract, and a scripted session answers it |
| layout | `npm run test:layout` | ~1s | **where** files land, for every layout — generates, installs nothing |
| packaging | `npm run test:packaging` | ~1s | the tarball `npm publish` would upload |
| cli | `npm run test:cli` | ~2s | what `npx slop-factory` prints, to which stream, and its exit code |
| examples | `npm run examples:check` | ~2s | the committed `examples/` still match the generator |
| generation | `npm run verify` | ~35s | generated projects install and pass their own gate |

Two of them also run on **every commit**. `.githooks/pre-commit` — wired by `prepare`, the same way
generated projects wire theirs — runs `check:all` and `examples:check`, about 3.3 seconds together. That
second step is there because "changed a module, forgot to refresh the examples" is the most frequent mistake
in this repository's history, and it is the one a human would otherwise push.

`test:prompts`, `test:cli`, `test:layout` and `verify` are deliberately **not** in the hook: the test suites
only fire on generator or CLI changes and each rebuilds, and the last takes minutes. All run in CI —
`modules/vitest-projects-in-ci.test.ts` fails if a Vitest project is ever left out of the workflow.

The suites are independent: any combination of them can run in one `vitest` invocation. That was not always
true — `packaging` used to build inside a hook, and the build deletes `dist/` out from under every suite
that reads it, so combining projects failed nondeterministically and blamed whichever one happened to be
reading ([#23](https://github.com/vx-daniel/slop-factory/issues/23)). The build now lives in the npm scripts,
where every other `test:*` script already had it, and `modules/dist-is-not-a-test-fixture.test.ts` fails if a
suite starts building again.

**`dist/` must be built before any suite that reads it.** Every `test:*` script does that for you; a bare
`npx vitest run` does not, and `packaging` says so by name rather than failing as a missing tarball entry.

The linter is the Biome config the factory ships, reached by `extends` — see
[`module-contract.md`](module-contract.md). A green `npm run lint` here therefore means what it means in a
generated project: same rules, same naming plugin, same pinned version, with
`modules/gate/gate-config.test.ts` asserting the last two cannot drift apart.

`.github/workflows/ci.yml` runs all of them on every push and pull request.

## Why `prompts` is its own suite

Because of a real silent failure. The runtime prompt was deleted during a refactor and **all 87 generation
assertions still passed** — that suite supplies answers directly to `runActions`, so it never sees the
prompt list at all. The generated project had no `engines`, no tsx, and a `check:all` that died on
`Cannot find package 'tsx'`.

The lesson generalises: a module is selected by matching an **answer**, so a prompt that stops producing
that answer disables the module silently. Anything that asserts on modules while bypassing prompts cannot
catch it — only reading the prompt list can. `plopfile.ts` now also *throws* on an unknown or missing
answer rather than casting it.

## Why the expensive one ships anyway

`npm run verify` generates each combination into a temp directory, git-inits it, installs it, and runs the
generated project's own gate and coverage. It is the only thing that can catch the failures that matter
most — every one of these installs and typechecks cleanly, or typechecks and then fails elsewhere:

- a fragment merge producing a project whose dependencies do not satisfy its own scripts;
- a file rendered when it should have been copied verbatim (the `${{ }}` collision);
- the pre-commit hook copied without its executable bit — git then declines to run it, silently;
- `.gitignore`'s order-sensitive `config.*.toml` / `!config.defaults.toml` pair being reordered;
- `coverage:readme` not finding the marker block in the rendered README;
- a test file that runs but does not typecheck;
- a workflow interpolating the wrong package manager;
- a coverage-floor guard that cannot find the config it guards (real: it resolved `bunfig.toml` a fixed
  number of levels up, which was the project root under one layout only).

It git-inits each tree because three of those do not exist without one — `prepare` prints "fatal: not in a
git directory" and passes anyway, so an un-inited tree silently skips the hook wiring it is supposed to
verify.

## The matrix is derived, and sampled

`tests/generation.test.ts` computes every reachable answer set from the contract's own constants —
`PROJECT_STRUCTURES × PACKAGE_MANAGERS × TEST_RUNNERS ×` feature sets — with one reachability rule
encoded: `bun-test` pairs only with the bun manager, because the prompt is skipped for npm and pnpm.

A hand-written matrix drifts from the prompts in both directions and **neither shows as a failure**: a
combination the prompts gain is never gated, and one they lose is gated forever against a generator that
cannot produce it. Deriving it means adding a manager or runner extends the matrix without anyone
remembering to.

**Every reachable combination is enumerated; a subset installs and gates.** Sampling is separate from
reachability and stated as a predicate rather than by omission:

- **Single-package gets no discount** — it is the default and the cheapest to get wrong. A test asserts no
  `single` row is ever sampled out.
- **The workspace layout gets two representative pairs**, because its risk concentrates in test
  *discovery* and the two runners scope that by mechanisms one project cannot both exercise: Vitest via
  `--dir packages`, `bun test` via `root` in `bunfig.toml`.

The uninstalled combinations are **printed** in the run output, not silently dropped, and the count is
pinned so widening or narrowing the sampling is a deliberate edit. A suite that covers less than it appears
to is worse than a slow one. Those are still covered for file *placement* by the layout suite.

Current status: **148 passed, 14 skipped of 162.** The skips are runner- or feature-specific and fully
accountable — a coverage-README test that only applies under Vitest, a `bunfig.toml` test that only applies
under `bun test`, and a config-defaults test that only applies when the feature is on.

## Read the skips before trusting a green run

`isPackageManagerAvailable` **skips** rather than fails when a manager is missing from `PATH`, so a machine
without pnpm reports green having verified nothing about pnpm. That is the right behaviour — an absent Bun
should not read as a broken factory — but it means "verify passed" and "every combination was exercised"
are different claims. Check which rows actually ran.

## The layout suite exists because generation is too expensive to answer cheap questions

`npm run test:layout` generates into a temp directory and reads the tree, installing nothing. File
placement is decided entirely by the copy actions, so generating and looking is proof — and it costs
seconds where a generation row costs minutes.

It is also the only suite that exercises both layouts for every assertion about *where* things go, which
is what makes the sampling above defensible.

## Behaviour preservation

For any change that should not alter generated output, `npm run examples:check` is the proof: it
regenerates each committed example into a temp directory and compares **content and executable bits**,
excluding nothing. Zero drift is a byte-for-byte guarantee.

It also fails on an **orphaned** example directory — one no longer produced by any entry in
`EXAMPLE_PROJECTS`. Without that check a renamed example survives on disk, still committed, describing
answers the generator no longer accepts, and the drift check reports `ok`.

## Related

- [`module-contract.md`](module-contract.md) — the channels a change can affect
- [`publishing.md`](publishing.md) — what the packaging suite guards, and why
