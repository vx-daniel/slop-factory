# CLAUDE.md — slop-factory

**This file is about the factory itself, not about the projects it generates.** Those get their own
`CLAUDE.md`, rendered from `modules/base/CLAUDE.md.hbs`. Editing this file changes nothing a consumer sees;
editing that template changes every generated project. Confusing the two is the most expensive mistake
available in this repo, so check which side of the line you are on before writing.

There are two of everything, for the same reason:

| Concern | The factory's own | What ships to generated projects |
|---|---|---|
| Agent instructions | `CLAUDE.md` (this file) | `modules/base/CLAUDE.md.hbs` |
| Agent rules | `.claude/rules/` | `modules/base/source/.claude/rules/` |
| Linter | Biome (`biome.jsonc`, which **extends** the shipped config) | Biome (`modules/gate/source/biome.json`) |
| Docs | `docs/` | each module's `source/docs/` |
| Pre-commit hook | `.githooks/pre-commit` | `modules/base/source/.githooks/pre-commit` |

The linter row is the one pair that is deliberately **not** independent: `biome.jsonc` *extends*
`modules/gate/source/biome.json`, so the factory is held to exactly the standard it prescribes and the rules
have only one copy. That is the strongest form of this pattern, not an exception to it — where two files can
be one plus a delta, they should be. `modules/gate/gate-config.test.ts` guards the two couplings that
arrangement creates: the Biome version pins must match exactly, and the factory's `.biome/naming.grit` must
stay byte-identical to the payload one.

## Verification (run before declaring any change done)

```bash
npm run check:all       # THE gate: biome → tsc --noEmit → unit tests, cheap-first
npm run test:layout     # where files land, both layouts — seconds, installs nothing
npm run examples:check  # zero drift = generated output is byte-for-byte unchanged
npm run verify          # slow (~35s): generates + installs + gates 10 of 16 combinations
```

`check:all` is necessary but **not sufficient**. It proves the factory compiles and its own tests pass — it
says nothing about what the generator *produces*. A change to any module needs at least
`examples:check`, and a change that can affect generated behaviour needs `verify`.

[`docs/verification.md`](docs/verification.md) explains what each suite can and cannot see, and how to read
a green run — including that `verify` **skips** combinations whose package manager is absent from `PATH`, so
green does not mean every row ran.

## Rules

[`.claude/rules/`](.claude/rules/) — conventions for this repository, each stating the failure mode it
exists to block so a future reader can tell when that mode has shifted.

| Rule | Blocks |
|---|---|
| [generated-artifacts.md](.claude/rules/generated-artifacts.md) | Editing `examples/` or `dist/` instead of the generator that produces them |
| [asserting-on-file-content.md](.claude/rules/asserting-on-file-content.md) | Assertions that match a file's prose rather than its data |

## The two rules most often broken here

**Behaviour-preserving changes must prove it.** `examples:check` regenerates every committed example and
compares content *and* executable bits, excluding nothing. If a refactor should not change generated
output, zero drift is the receipt.

If drift appears, **read the diff before refreshing** — every time it has been inspected it revealed either
an intended comment change or a real bug. And never fix a generated file by editing it: work up the chain to
the module that produces it. See [generated-artifacts.md](.claude/rules/generated-artifacts.md).

**A guard is not done until you have watched it fail.** Break the thing it guards, run it, see red, restore.
Two guards in this repo were written, reviewed, and green while completely inert. See
[`.claude/rules/asserting-on-file-content.md`](.claude/rules/asserting-on-file-content.md), which exists
because that failure recurred three times in one session.

## Where things are

- `plopfile.ts` — prompts, answer normalization, and the custom actions. Answers are narrowed **once**, in
  `toProjectAnswers`, so a renamed prompt fails in one obvious place.
- `modules/module-contract.ts` — the contract every module implements, and the reasoning behind it. Read
  the header comment before adding a channel.
- `modules/<name>/module.ts` — one module. `source/` and `packageSource/` are copied verbatim; `.hbs` files
  beside the descriptor are rendered.
- `modules/registry.ts` — registration order, and which module sets are mutually exclusive.
- `tests/` — the suites that need a built plopfile. `modules/*.test.ts` are the cheap unit tests.

[`docs/module-contract.md`](docs/module-contract.md) is the orientation document. Read it before adding or
moving a module.

## Things that look like bugs and are not

- **The factory runs its built output, always — even in development.** Two measured constraints force it;
  see [`docs/publishing.md`](docs/publishing.md). Do not "simplify" a script to run the `.ts` directly.
- **`source/` trees are never rendered.** Handlebars and GitHub Actions both claim `{{ }}`. A workflow
  containing `${{ }}` run through Handlebars emits a bare `$` and fails only in CI.
- **`modules/*/source` and `modules/*/packageSource` are excluded from tsc, Biome and Vitest.** Those files
  target the *generated* project's toolchain — different TypeScript version, aliases that resolve only
  there. Findings reported against them are not findings.
- **package.json and template-data conflicts throw rather than last-write-wins.** Two modules disagreeing
  is a factory bug; silently picking one would ship a project whose gate runs something nobody chose.

## Conventions

Verbose names, no abbreviations. Comments carry **why**, names carry **what**. Plain over clever — this
codebase is read by agents starting from zero context, so an idiom that needs prior knowledge costs more
than the lines it saves.

Constants over magic values, at the top of the file. Options objects at three or more parameters.

When a change makes a document wrong, fix the document in the same change. Several README claims went stale
as side effects of changes that were themselves correct and tested — including a worked example that
pointed at a file deleted two changes earlier. A confidently wrong document is worse than none, because it
reads as authoritative.
