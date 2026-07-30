# Documentation

One document per module this project was generated with. Each explains **why** its part is configured
the way it is — the reasoning that is otherwise only recoverable by reading the config and guessing.

| Document | Covers |
|---|---|
| [TypeScript setup](typescript-setup.md) | Path aliases, the mandatory `.js` extension, strictness, and choosing an emit strategy. |
| [The gate](the-gate.md) | One ordered check list, how to add a check, and what the naming plugin enforces. |
| [Running on Node](node-runtime.md) | Why tsx is load-bearing, and what bare Node cannot do with this tsconfig. |
| [Testing and coverage](testing-with-vitest.md) | The 85% floor on all four metrics, the `*.io.ts` escape valve, and the reporters. |
| [Configuration](configuration.md) | The three layers, key-by-key merging, and why secrets are referenced by name. |

These are generated per project, so this index lists exactly what is here — not a superset describing
options that were not selected.

## Where else the reasoning lives

- **[../CLAUDE.md](../CLAUDE.md)** — the agent-facing orientation: what to run, what is deliberately
  absent, and the known caveats.
- **[../README.md](../README.md)** — the human-facing entry point.
- **`../.claude/rules/`** — the conventions themselves (naming, TypeScript patterns, Zod, options
  objects, discipline, broken windows, memory). Each file states whether it is mechanically gated or
  review-enforced.
- **`../.claude/skills/`** — procedures rather than conventions, notably `test-quality` for writing and
  reviewing tests.

## If you change a configured behaviour, change its document

A document describing a setting the project no longer has is worse than no document, because a reader —
particularly an agent — will act on it. The docs are part of the change, not a follow-up to it.
