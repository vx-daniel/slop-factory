---
trigger_phrase:
  haiku: "code quality enforcement ratchet"
  opus: "broken windows codebase quality ratchet"
  sonnet: "broken windows code quality ratchet"
always_on: true
---

# Broken Windows

## The Principle

Every agent owns codebase quality. If you encounter something broken — fix it. No "pre-existing issue" dismissals. No "out of scope" hand-waving. The ratchet only turns one direction: cleaner.

## What Counts as a Broken Window

Fix these when you encounter them, even if they are unrelated to your primary task:

- **Test failures** — any test that was passing before your changes must still pass after. If you find a pre-existing failing test, fix it.
- **Type errors** — `tsc --noEmit` must produce zero errors. Fix any you find.
- **Lint/format violations** — Biome violations (`npm run lint`, `npm run format`) must be resolved.
- **Dead code** — commented-out blocks, unused variables, unreachable branches. Delete them.
- **JSDoc violations** — missing or wrong-format doc comments on exported symbols.
- **Hardcoded magic numbers** — numeric literals that should be named constants.

## What Does NOT Count

Do not treat these as broken windows — they are architectural decisions or planned work:

- Functionality you disagree with but that works correctly and has tests
- Missing features that weren't in scope for the original ticket
- Subjective style choices not covered by an explicit rule
- Performance improvements that aren't causing observable problems
- Code in files you haven't read and aren't touching

## Don't Broaden Scope While Cleaning

Relocating, promoting, or generalizing a rule, convention, config flag, or abstraction to a **broader scope** than where it was written is not a cleanup — it is a new claim that the thing applies everywhere the wider scope reaches. Before moving it, verify it fits *every* context the new scope covers, and re-scope (or drop) framing that was true only at the old location. The ratchet turns toward *cleaner*, not *broader*.


## Response Protocol

When you find a broken window mid-task:

1. **Note it** — identify the issue before fixing it
2. **Fix it** — apply the smallest correct fix; don't refactor surrounding code opportunistically
3. **Verify it** — confirm the fix doesn't introduce new issues (run the relevant check)
4. **Continue** — return to your primary task

If fixing the broken window would require more than ~15 minutes of work or touch more than 3 unrelated files, create a follow-up issue for it instead and continue your primary task. This prevents scope explosion while preserving the ratchet.

## Inline Duplication Check

Before writing an expression that computes a derived value (path resolution, string formatting, config lookups), **grep for the pattern first**. If the same expression already exists in 2+ files, there should be a helper — use it. If there isn't one and you're about to create occurrence #3, extract a helper *now* instead of adding another inline copy.

The cost of one grep before writing is negligible. The cost of 20 inline copies when the pattern changes is not.

## Conflict with Primary Task

Broken window fixes come **after** the primary task is functionally complete, not before. Do not let cleanup block delivery. Order:

1. Complete primary task
2. Run `npm run check:all` and `npm run test`
3. Fix any broken windows surfaced by those checks
4. Re-run checks to confirm clean state
