# check-test-quality.sh

Tier 1 grep-based pre-screen for test fig-leaf signals. Bundled with the `test-quality` skill.

Catches the deterministic anti-patterns the skill enumerates without requiring LLM analysis. Use as a fast pre-screen before declaring tests "done," or as a CI gating check. Tier 2 (LLM-based adversarial review) should still run for the deeper checks that grep can't reach.

## Requirements

- bash 4+, plus GNU `xargs` — the script uses `xargs -d` / `-r`, which BSD/macOS `xargs` rejects (install `findutils` on macOS)
- `ripgrep` (`rg`) — preferred, falls back to `grep` if unavailable
- `git` — required only for `--diff` mode

No install step. Make the script executable and invoke directly.

## Quick start

Paths below are relative to this `scripts/` directory. From a project root the script is at
`.claude/skills/test-quality/scripts/check-test-quality.sh`; the skill's workflows invoke it as
`./scripts/check-test-quality.sh` from the skill root. All three name the same file.

```bash
# scan all test files in the current directory
./check-test-quality.sh

# scan a specific path
./check-test-quality.sh path/to/tests

# CI: only check files in the PR diff
./check-test-quality.sh --diff origin/main..HEAD

# CI gating: fail the build on any HIGH-severity finding
./check-test-quality.sh --diff origin/main..HEAD --strict

# machine-readable output for CI tooling
./check-test-quality.sh --json
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No findings; or findings present without `--strict`; or `--strict` set but no HIGH findings (MEDIUM and LOW never gate) |
| `1` | HIGH-severity findings present AND `--strict` is set |
| `2` | Script error (bad arguments, missing required tool, etc.) |

## Checks

Each check has a name, a severity, and a target file pattern. `--check` takes a comma-separated **allowlist** — naming a check runs only that one. There is no flag to disable a single check; select the ones you want instead.

### disabled-tests (HIGH / MEDIUM)

Catches committed `.skip()`, `.todo()`, `.only()` on `test` / `it` / `describe`.

| Pattern | Severity | Why |
|---|---|---|
| `.skip(` | HIGH | Disabled test in committed code. Must have a tracking issue or be re-enabled. |
| `.todo(` | MEDIUM | Unimplemented test. Should have a tracking issue. |
| `.only(` | HIGH | Silently skips every other test in the file. MUST be removed before merge. |

### ts-suppression (HIGH / MEDIUM)

Catches TypeScript error suppression in test files. Test files commonly have legitimate reasons for type assertions, but suppression of real errors is a fig-leaf signal.

| Pattern | Severity | Why |
|---|---|---|
| `@ts-expect-error` | MEDIUM | Suppresses a type error; verify the test isn't hiding a real problem |
| `@ts-ignore` | HIGH | Prefer `@ts-expect-error` (fails when no longer needed); investigate the underlying type issue |

Applies only to `.ts` / `.tsx` test files.

### snapshot-auto-update (HIGH / MEDIUM)

Catches two patterns:

1. **Auto-update flags in test commands** in `package.json` scripts or CI config files — `vitest -u` / `vitest --update`, `bun test -u` / `bun test --update-snapshots`, `jest -u` / `jest --updateSnapshot`. The three tools spell the long form differently; the grep matches all of them. Snapshots regenerated this way are committed without inspection.

2. **Snapshot files modified without sibling source changes** (`--diff` mode only) — a `.snap` file or `__snapshots__/` directory modified in a PR where no production source file in the same directory changed. Likely a snapshot regenerated without inspecting the diff.

### weak-assertions (LOW)

Catches assertion patterns that verify presence rather than correctness. **Severity is LOW because context matters** — these patterns are sometimes legitimate. Treat as advisory.

| Pattern | Why |
|---|---|
| `expect(x).toBeDefined()` | Verifies presence, not correctness. Often appropriate when combined with a stronger assertion; flag if it's the only assertion. |
| `expect(x).toBeTruthy()` | Passes for any non-empty value. Prefer specific equality. |
| `expect(() => fn()).not.toThrow()` | Verifies no crash, not correct output. Combine with output verification. |

These findings are advisory, not gating. Even with `--strict`, LOW findings do not cause exit 1.

### swallowed-errors (HIGH)

Catches empty `catch` blocks in test files: `catch (e) {}` or `catch {}`. These swallow assertion errors, causing tests to pass when they should fail.

### coverage-regression (MEDIUM, `--diff` mode only)

Catches config changes that reduce or remove coverage requirements. The key differs per tool: Vitest nests `thresholds: { lines, branches, functions, statements }` under `test.coverage`, while `coverageThreshold` is the Jest and `bunfig.toml` spelling. The check greps the numeric threshold lines, so it catches both shapes. Often legitimate (the project moved its coverage targets), but worth surfacing for explicit justification.

## Severity vocabulary: HIGH/MEDIUM/LOW vs S1/S2/S3

The skill uses two distinct severity ontologies — this is intentional, but worth understanding.

**Script severity (HIGH / MEDIUM / LOW)** measures **detection confidence**:
- **HIGH** — deterministic violation; grep-confident; minimal context required (e.g., committed `.only`, empty `catch`, `--update-snapshots` flag)
- **MEDIUM** — judgment-required but clear in most contexts (e.g., `@ts-expect-error`, snapshot regenerated without sibling source change)
- **LOW** — advisory; context matters; never gating (e.g., `toBeDefined()` could legitimately be the only assertion in some cases)

**Audit-deliverable severity (S1 / S2 / S3)** measures **consequence** (blast radius × likelihood):
- **S1** — active regression class; direct precedent; must fix or known evasion
- **S2** — structural risk worth filing; cross-cutting; no active regression but invisible drift
- **S3** — smell worth tracking; per-file; advisory

**These axes are related but not identical.** A LOW script finding can legitimately be an S1 audit finding (e.g., `toBeDefined()` is the only assertion on a function that produces a critical contract surface). A HIGH script finding can be S3 (e.g., a `.skip()` with a clear tracking issue noted in the comment immediately above it).

**Translation rule for synthesis:** when promoting script findings into the audit deliverable, ask "what is the consequence if this pattern ships?", not "how confident was the script?" Detection confidence is a means; consequence is the end. Use the script's HIGH/MEDIUM/LOW as input data; assign S1/S2/S3 based on the contract-surface lens the workflow applies.

When the audit deliverable lists script findings (e.g., "Tier 1 grep pre-screen: 0 HIGH findings"), keep the script's vocabulary verbatim. When the audit's own findings appear, use S1/S2/S3. Don't mix or collapse.

## Test file detection

Files matching any of these patterns are treated as test files:

- `*.test.ts`, `*.test.tsx`, `*.test.js`, `*.test.jsx`, `*.test.mjs`, `*.test.cjs`
- `*.spec.ts`, `*.spec.tsx`, `*.spec.js`, `*.spec.jsx`
- `*_test.go`
- `test_*.py`, `*_test.py`
- `*_spec.rb`

## Excluded directories

The script automatically excludes test files inside common dependency and build directories: `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `out/`, `target/`. Upstream packages ship test suites that use patterns this script flags (`.skip`, `@ts-ignore`, etc.) as part of their normal development workflow — scanning them produces false-positive floods.

For recommended usage, point the script at a scoped path:

```bash
./check-test-quality.sh src/tests           # scoped to test dir
./check-test-quality.sh tests/              # scoped to test dir
./check-test-quality.sh                     # current dir (excludes the common build dirs)
```

If you genuinely need to scan something inside `node_modules/`, edit the exclusion `grep -vE` pattern inside `collect_test_files` in the script, or remove that filter. It is an inline literal, not a named constant — there is no single variable to override.

## Flags

| Flag | Description |
|---|---|
| `--diff RANGE` | Only check files changed in the git diff `RANGE` (e.g. `origin/main..HEAD`). Required for `coverage-regression`; recommended for CI. |
| `--check LIST` | Comma-separated list of checks to run. Default: all checks. |
| `--strict` | Exit 1 on any HIGH-severity finding. Use in CI gating. |
| `--json` | Output structured JSON. Severity / check / file / line / description per finding. |
| `--verbose` | Show diagnostic output (which checks ran, file count, diff range). |
| `--help` | Show help and exit. |
| `--version` | Show version and exit. |

## CI integration

### GitHub Actions

```yaml
- name: Test quality pre-screen
  run: |
    git fetch origin ${{ github.base_ref }}
    ./scripts/check-test-quality.sh \
      --diff origin/${{ github.base_ref }}..HEAD \
      --strict
```

### GitLab CI

```yaml
test-quality-screen:
  script:
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - ./scripts/check-test-quality.sh \
        --diff "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME..HEAD" \
        --strict
```

### Pre-commit hook

```bash
#!/usr/bin/env bash
# .git/hooks/pre-commit
./check-test-quality.sh --diff --cached --strict
```

## What this script deliberately does NOT do

These checks require AST analysis or behavioral understanding and are out of scope for the grep layer. They belong in Tier 2 (LLM-based review):

- "The only assertion is `toBeDefined()`" — requires understanding test block boundaries
- "Mock setup is > 50% of the test" — requires parsing test structure
- "Test name describes implementation, not behavior" — requires semantic judgment
- "Test would not catch a realistic mutation" — requires understanding the SUT
- "The mock is missing methods the real module has" — requires comparing mock to real module

If you need these, layer an LLM-based reviewer on top of this script's output.

## Tuning false positive rates

The check set is deliberately conservative. If you find:

- **Too many LOW findings** — `weak-assertions` is the most common offender. Combine with `--check disabled-tests,ts-suppression,snapshot-auto-update,swallowed-errors` to exclude them.
- **`@ts-expect-error` flagged on legitimate tests** — consider downgrading to a comment-based ignore convention, OR scope the check to specific paths.
- **Snapshot-without-sibling triggering on legitimate work** — happens when sources are renamed but snapshots are not; review the heuristic in the script and tune the sibling-search regex.

For project-specific tuning, copy this script into your repo and edit the check definitions. The skill ships a generic baseline; projects adapt.

## Version history

- **0.1.3** — Default exclusion of `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `out/`, `target/`. `rg --files` respects gitignore in a git repo, but loses that protection outside one (e.g. `/tmp/bunx-*` extraction dirs). Naively scanning a project root would previously surface false-positive floods from upstream test suites (e.g. zod's tests use `@ts-ignore` normally). Belt-and-suspenders filter at the file-collection step.
- **0.1.2** — UX fix: emit a stderr warning when zero test files matched the target (path typo, renamed directory, wrong glob). Same UX class as the v0.1.0 silent-exit bug — a CI job pointed at a missing path would otherwise report "clean" forever. Exit code stays 0 (legitimate zero-files case: `--diff` against a PR that didn't touch tests).
- **0.1.1** — Bug fix: script silently exited 1 with zero output on suites with no findings. Caused by `[[ VERBOSE ]] && echo ... >&2` pattern at the top of check functions: when `VERBOSE=0`, the short-circuited expression returned exit 1, propagated through implicit `return` in `check_coverage_regression`'s early-return path, killed the script under `set -e`. Converted all conditional-echo patterns to `if/then/fi` form to prevent this and future regressions. Affects calibration: any audit that relied on "Tier 1 script returned clean" without explicit verbose output was actually reading a silent failure.
- **0.1.0** — Initial release. Six check categories. Bash + ripgrep/grep.
