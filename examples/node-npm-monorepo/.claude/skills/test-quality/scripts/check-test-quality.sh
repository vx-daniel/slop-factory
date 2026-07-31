#!/usr/bin/env bash
#
# check-test-quality.sh
#
# Tier 1 grep-based pre-screen for test fig-leaf signals. Catches the deterministic
# anti-patterns named in the test-quality skill without LLM analysis.
#
# Use as a fast pre-screen before declaring tests "done" or as a CI gating check.
# Tier 2 (LLM-based adversarial review) should still run for the deeper checks.
#
# Exit codes:
#   0 = no findings, or findings present but --strict not set
#   1 = HIGH-severity findings present AND --strict is set
#   2 = script error (bad args, missing tool, etc.)
#
# See ./README.md for full check descriptions.

set -euo pipefail

# ─── version + defaults ─────────────────────────────────────────────────────────

VERSION="0.1.3"

# default checks (comma-separated). pass --check to override.
ALL_CHECKS="disabled-tests,ts-suppression,snapshot-auto-update,weak-assertions,swallowed-errors,coverage-regression"

# test file patterns. case-sensitive.
TEST_FILE_REGEX='.*(\.test|\.spec)\.(ts|tsx|js|jsx|mjs|cjs)$|.*_test\.go$|test_.*\.py$|.*_test\.py$|.*_spec\.rb$'

# ─── flag state ─────────────────────────────────────────────────────────────────

STRICT=0
JSON=0
DIFF_RANGE=""
CHECKS="$ALL_CHECKS"
TARGET_DIR="."
VERBOSE=0

# ─── tool detection ─────────────────────────────────────────────────────────────

if command -v rg >/dev/null 2>&1; then
  GREP_TOOL="rg"
else
  GREP_TOOL="grep"
fi

if command -v git >/dev/null 2>&1; then
  HAVE_GIT=1
else
  HAVE_GIT=0
fi

# ─── color setup (TTY only) ─────────────────────────────────────────────────────

if [[ -t 1 ]] && [[ "${NO_COLOR:-}" == "" ]]; then
  CLR_RED=$'\033[31m'
  CLR_YELLOW=$'\033[33m'
  CLR_CYAN=$'\033[36m'
  CLR_DIM=$'\033[2m'
  CLR_BOLD=$'\033[1m'
  CLR_RESET=$'\033[0m'
else
  CLR_RED=""
  CLR_YELLOW=""
  CLR_CYAN=""
  CLR_DIM=""
  CLR_BOLD=""
  CLR_RESET=""
fi

# ─── usage ──────────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
check-test-quality.sh v${VERSION}

Grep-based pre-screen for test fig-leaf signals. Bundled with the
test-quality skill.

Usage:
  check-test-quality.sh [options] [path]

Options:
  --diff RANGE         Only check files changed in git diff RANGE
                       (e.g. --diff origin/main..HEAD)
  --check LIST         Comma-separated checks to run. Default: all.
                       Available: disabled-tests, ts-suppression,
                                  snapshot-auto-update, weak-assertions,
                                  swallowed-errors, coverage-regression
  --strict             Exit 1 on any HIGH-severity finding
  --json               Output structured JSON instead of human-readable
  --verbose            Show files being scanned and other diagnostics
  --help               Show this help and exit
  --version            Show version and exit

Examples:
  check-test-quality.sh                                # scan cwd
  check-test-quality.sh path/to/tests                  # scan a specific dir
  check-test-quality.sh --diff origin/main..HEAD       # scan PR diff
  check-test-quality.sh --check disabled-tests --strict
  check-test-quality.sh --json                         # CI-friendly

Exit codes:
  0  no findings, or findings without --strict
  1  HIGH-severity findings with --strict
  2  script error
EOF
}

# ─── arg parsing ────────────────────────────────────────────────────────────────

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --diff)
        DIFF_RANGE="${2:-}"; shift 2
        if [[ -z "$DIFF_RANGE" ]]; then
          echo "error: --diff requires a range argument" >&2; exit 2
        fi
        if [[ "$HAVE_GIT" == "0" ]]; then
          echo "error: --diff requires git" >&2; exit 2
        fi
        ;;
      --check)
        CHECKS="${2:-}"; shift 2
        if [[ -z "$CHECKS" ]]; then
          echo "error: --check requires a list argument" >&2; exit 2
        fi
        ;;
      --strict) STRICT=1; shift ;;
      --json)   JSON=1; shift ;;
      --verbose) VERBOSE=1; shift ;;
      --help|-h) usage; exit 0 ;;
      --version) echo "$VERSION"; exit 0 ;;
      -*) echo "error: unknown flag $1" >&2; usage >&2; exit 2 ;;
      *) TARGET_DIR="$1"; shift ;;
    esac
  done
}

# ─── findings collection ────────────────────────────────────────────────────────

# findings format (one per line, tab-separated):
#   SEVERITY \t CHECK \t FILE \t LINE \t DESCRIPTION
# stored in a temp file because bash arrays of complex strings are awkward.

FINDINGS_FILE=$(mktemp)
trap 'rm -f "$FINDINGS_FILE"' EXIT

add_finding() {
  printf "%s\t%s\t%s\t%s\t%s\n" "$1" "$2" "$3" "$4" "$5" >>"$FINDINGS_FILE"
}

# ─── file collection ────────────────────────────────────────────────────────────

collect_test_files() {
  local files
  if [[ -n "$DIFF_RANGE" ]]; then
    files=$(git diff --name-only --diff-filter=AM "$DIFF_RANGE" 2>/dev/null | \
            grep -E "$TEST_FILE_REGEX" || true)
  else
    if [[ "$GREP_TOOL" == "rg" ]]; then
      files=$(rg --files "$TARGET_DIR" 2>/dev/null | \
              grep -E "$TEST_FILE_REGEX" || true)
    else
      files=$(find "$TARGET_DIR" -type f 2>/dev/null | \
              grep -E "$TEST_FILE_REGEX" || true)
    fi
  fi
  # Exclude common dependency / build directories. node_modules is the
  # main offender — upstream packages ship tests that use @ts-ignore and
  # other patterns flagged by this script, producing false-positive floods
  # when the script is naively pointed at a repo root. rg respects gitignore
  # by default but loses that protection when run outside a git repo (e.g.
  # /tmp/bunx-* extraction dirs). Belt-and-suspenders: filter here too.
  if [[ -n "$files" ]]; then
    files=$(echo "$files" | grep -vE '/(node_modules|\.git|dist|build|coverage|\.next|\.nuxt|\.svelte-kit|out|target)/' || true)
  fi
  echo "$files"
}

collect_changed_config_files() {
  # only relevant in --diff mode
  if [[ -z "$DIFF_RANGE" ]]; then return; fi
  git diff --name-only --diff-filter=M "$DIFF_RANGE" 2>/dev/null | \
    grep -E '(vitest|jest|bun)\.config\.(ts|js|mjs|cjs)$|bunfig\.toml$|package\.json$' || true
}

collect_changed_snapshot_files() {
  if [[ -z "$DIFF_RANGE" ]]; then return; fi
  git diff --name-only "$DIFF_RANGE" 2>/dev/null | \
    grep -E '\.snap$|__snapshots__/' || true
}

# ─── individual checks ──────────────────────────────────────────────────────────

# search a list of files for a pattern, emit findings.
# args: pattern severity check description
search_files_for_pattern() {
  local files="$1" pattern="$2" severity="$3" check="$4" description="$5"
  [[ -z "$files" ]] && return
  if [[ "$GREP_TOOL" == "rg" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      # rg -n format: file:line:content
      local file lineno
      file=$(echo "$line" | cut -d: -f1)
      lineno=$(echo "$line" | cut -d: -f2)
      add_finding "$severity" "$check" "$file" "$lineno" "$description"
    done < <(echo "$files" | xargs -d '\n' -r rg -n --no-heading --color=never -e "$pattern" 2>/dev/null || true)
  else
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      local file lineno
      file=$(echo "$line" | cut -d: -f1)
      lineno=$(echo "$line" | cut -d: -f2)
      add_finding "$severity" "$check" "$file" "$lineno" "$description"
    done < <(echo "$files" | xargs -d '\n' -r grep -nE "$pattern" 2>/dev/null || true)
  fi
}

check_disabled_tests() {
  local files="$1"
  if [[ "$VERBOSE" == "1" ]]; then echo "  running: disabled-tests" >&2; fi
  search_files_for_pattern "$files" \
    '\b(test|it|describe)\.skip\(' \
    "HIGH" "disabled-tests" \
    ".skip() on test — committed disabled test, must have tracking issue or be re-enabled"
  search_files_for_pattern "$files" \
    '\b(test|it|describe)\.todo\(' \
    "MEDIUM" "disabled-tests" \
    ".todo() on test — unimplemented test, must have tracking issue"
  search_files_for_pattern "$files" \
    '\b(test|it|describe)\.only\(' \
    "HIGH" "disabled-tests" \
    ".only() on test — silently skips every other test in the file, MUST be removed before merge"
}

check_ts_suppression() {
  local files="$1"
  if [[ "$VERBOSE" == "1" ]]; then echo "  running: ts-suppression" >&2; fi
  # only check .ts/.tsx test files
  local ts_files
  ts_files=$(echo "$files" | grep -E '\.tsx?$' || true)
  [[ -z "$ts_files" ]] && return
  search_files_for_pattern "$ts_files" \
    '@ts-expect-error' \
    "MEDIUM" "ts-suppression" \
    "@ts-expect-error in test — suppresses type errors; verify the test isn't hiding a real problem"
  search_files_for_pattern "$ts_files" \
    '@ts-ignore' \
    "HIGH" "ts-suppression" \
    "@ts-ignore in test — prefer @ts-expect-error (fails when no longer needed); investigate the underlying type issue"
}

check_snapshot_auto_update() {
  local files="$1"
  if [[ "$VERBOSE" == "1" ]]; then echo "  running: snapshot-auto-update" >&2; fi

  # check package.json + CI configs for auto-update flags
  local config_files
  if [[ -n "$DIFF_RANGE" ]]; then
    config_files=$(git diff --name-only --diff-filter=AM "$DIFF_RANGE" 2>/dev/null | \
                   grep -E 'package\.json$|\.github/workflows/.*\.ya?ml$|\.gitlab-ci\.yml$|\.circleci/config\.yml$' || true)
  else
    if [[ "$GREP_TOOL" == "rg" ]]; then
      config_files=$(rg --files "$TARGET_DIR" 2>/dev/null | \
                     grep -E 'package\.json$|\.github/workflows/.*\.ya?ml$|\.gitlab-ci\.yml$|\.circleci/config\.yml$' || true)
    else
      config_files=$(find "$TARGET_DIR" -type f 2>/dev/null | \
                     grep -E 'package\.json$|\.github/workflows/.*\.ya?ml$|\.gitlab-ci\.yml$|\.circleci/config\.yml$' || true)
    fi
  fi

  if [[ -n "$config_files" ]]; then
    # match -u or --update-snapshots in test invocations
    search_files_for_pattern "$config_files" \
      '(vitest|jest|bun test).*(--update-snapshots|--update|[[:space:]]-u[[:space:]]|[[:space:]]-u\")' \
      "HIGH" "snapshot-auto-update" \
      "auto-snapshot-update flag detected in test command — snapshots will regenerate without inspection; remove flag"
  fi

  # snapshot files modified WITHOUT corresponding source files (--diff only)
  if [[ -n "$DIFF_RANGE" ]]; then
    local snap_files
    snap_files=$(collect_changed_snapshot_files)
    if [[ -n "$snap_files" ]]; then
      while IFS= read -r snap; do
        [[ -z "$snap" ]] && continue
        # heuristic: look for a sibling .ts/.js/.tsx/.jsx changed in the same dir
        local dir
        dir=$(dirname "$snap")
        local sibling_changes
        sibling_changes=$(git diff --name-only "$DIFF_RANGE" 2>/dev/null | \
                          grep -E "^${dir}/.*\.(ts|tsx|js|jsx|mjs)$" | \
                          grep -v '\.test\.\|\.spec\.' || true)
        if [[ -z "$sibling_changes" ]]; then
          add_finding "MEDIUM" "snapshot-auto-update" "$snap" "0" \
            "snapshot file changed but no sibling source file changed — likely regenerated without inspecting the diff"
        fi
      done <<< "$snap_files"
    fi
  fi
}

check_weak_assertions() {
  local files="$1"
  if [[ "$VERBOSE" == "1" ]]; then echo "  running: weak-assertions" >&2; fi
  search_files_for_pattern "$files" \
    'expect\([^)]*\)\.toBeDefined\(\)' \
    "LOW" "weak-assertions" \
    "toBeDefined() — verifies presence, not correctness. Combine with shape/value check or remove if not load-bearing."
  search_files_for_pattern "$files" \
    'expect\([^)]*\)\.toBeTruthy\(\)' \
    "LOW" "weak-assertions" \
    "toBeTruthy() — passes for any non-empty value. Prefer specific equality/shape assertion."
  search_files_for_pattern "$files" \
    'expect\([^)]*\)\.not\.toThrow\(\)' \
    "LOW" "weak-assertions" \
    "not.toThrow() — verifies no crash, not correct output. Combine with output verification."
}

check_swallowed_errors() {
  local files="$1"
  if [[ "$VERBOSE" == "1" ]]; then echo "  running: swallowed-errors" >&2; fi
  # match empty catch blocks: catch (e) {} or catch (e) { } or catch {}
  search_files_for_pattern "$files" \
    'catch[[:space:]]*\([^)]*\)[[:space:]]*\{[[:space:]]*\}|catch[[:space:]]*\{[[:space:]]*\}' \
    "HIGH" "swallowed-errors" \
    "empty catch block in test — swallows assertion errors; the test may pass when it should fail"
}

check_coverage_regression() {
  if [[ "$VERBOSE" == "1" ]]; then echo "  running: coverage-regression" >&2; fi
  # only meaningful in --diff mode
  if [[ -z "$DIFF_RANGE" ]]; then
    if [[ "$VERBOSE" == "1" ]]; then echo "    (skipped: requires --diff)" >&2; fi
    return 0
  fi
  local config_files
  config_files=$(collect_changed_config_files)
  [[ -z "$config_files" ]] && return

  while IFS= read -r cfg; do
    [[ -z "$cfg" ]] && continue
    # find lines REMOVED from coverageThreshold blocks
    local removed
    removed=$(git diff "$DIFF_RANGE" -- "$cfg" 2>/dev/null | \
              grep -E '^-.*coverageThreshold|^-[[:space:]]*(lines|statements|branches|functions)[[:space:]]*:[[:space:]]*[0-9]' || true)
    if [[ -n "$removed" ]]; then
      add_finding "MEDIUM" "coverage-regression" "$cfg" "0" \
        "coverageThreshold reduced or removed in config — investigate justification"
    fi
  done <<< "$config_files"
}

# ─── runner ─────────────────────────────────────────────────────────────────────

run_check() {
  local check="$1" files="$2"
  case "$check" in
    disabled-tests) check_disabled_tests "$files" ;;
    ts-suppression) check_ts_suppression "$files" ;;
    snapshot-auto-update) check_snapshot_auto_update "$files" ;;
    weak-assertions) check_weak_assertions "$files" ;;
    swallowed-errors) check_swallowed_errors "$files" ;;
    coverage-regression) check_coverage_regression ;;
    *)
      echo "warning: unknown check '$check' — skipping" >&2
      ;;
  esac
}

# ─── output ─────────────────────────────────────────────────────────────────────

emit_human() {
  local file_count="$1"
  local high_count medium_count low_count total
  high_count=$(awk -F'\t' '$1=="HIGH"' "$FINDINGS_FILE" | wc -l)
  medium_count=$(awk -F'\t' '$1=="MEDIUM"' "$FINDINGS_FILE" | wc -l)
  low_count=$(awk -F'\t' '$1=="LOW"' "$FINDINGS_FILE" | wc -l)
  total=$((high_count + medium_count + low_count))

  if [[ "$total" == "0" ]]; then
    echo "${CLR_BOLD}check-test-quality:${CLR_RESET} ${CLR_CYAN}no findings${CLR_RESET} (${file_count} test file(s) scanned)"
    return
  fi

  echo "${CLR_BOLD}check-test-quality:${CLR_RESET} ${total} finding(s) across ${file_count} test file(s)"
  echo ""

  # group by severity, sort high → medium → low
  for severity in HIGH MEDIUM LOW; do
    local color
    case "$severity" in
      HIGH) color="$CLR_RED" ;;
      MEDIUM) color="$CLR_YELLOW" ;;
      LOW) color="$CLR_DIM" ;;
    esac
    while IFS=$'\t' read -r sev check file line desc; do
      [[ "$sev" != "$severity" ]] && continue
      if [[ "$line" == "0" ]]; then
        printf "  %s[%s]%s %s  %s\n    %s%s%s\n" \
          "$color" "$sev" "$CLR_RESET" "$check" "$file" \
          "$CLR_DIM" "$desc" "$CLR_RESET"
      else
        printf "  %s[%s]%s %s  %s:%s\n    %s%s%s\n" \
          "$color" "$sev" "$CLR_RESET" "$check" "$file" "$line" \
          "$CLR_DIM" "$desc" "$CLR_RESET"
      fi
    done < "$FINDINGS_FILE"
  done

  echo ""
  echo "${CLR_BOLD}summary:${CLR_RESET} ${CLR_RED}${high_count} HIGH${CLR_RESET}, ${CLR_YELLOW}${medium_count} MEDIUM${CLR_RESET}, ${CLR_DIM}${low_count} LOW${CLR_RESET}"
}

emit_json() {
  local file_count="$1"
  printf '{\n  "version": "%s",\n' "$VERSION"
  printf '  "files_scanned": %d,\n' "$file_count"
  printf '  "findings": [\n'
  local first=1
  while IFS=$'\t' read -r sev check file line desc; do
    [[ -z "$sev" ]] && continue
    if [[ "$first" == "1" ]]; then
      first=0
    else
      printf ',\n'
    fi
    # escape description for JSON (basic — handles quotes and backslashes)
    local desc_escaped
    desc_escaped=$(printf '%s' "$desc" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '    { "severity": "%s", "check": "%s", "file": "%s", "line": %s, "description": "%s" }' \
      "$sev" "$check" "$file" "$line" "$desc_escaped"
  done < "$FINDINGS_FILE"
  printf '\n  ]\n}\n'
}

# ─── main ───────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"

  if [[ "$VERBOSE" == "1" ]]; then
    echo "check-test-quality v${VERSION}" >&2
    echo "tool: $GREP_TOOL  |  strict: $STRICT  |  json: $JSON" >&2
    echo "checks: $CHECKS" >&2
    if [[ -n "$DIFF_RANGE" ]]; then echo "diff range: $DIFF_RANGE" >&2; fi
  fi

  local files
  files=$(collect_test_files)

  local file_count=0
  if [[ -n "$files" ]]; then
    file_count=$(echo "$files" | wc -l)
  fi

  if [[ "$VERBOSE" == "1" ]]; then echo "scanning $file_count test file(s)..." >&2; fi

  # Warn loudly when zero files matched — same UX class as the silent-exit-1
  # bug (v0.1.0). A CI job pointed at a renamed path would otherwise report
  # "clean" forever. Exit 0 retained because --diff against a PR that didn't
  # touch tests is a legitimate zero-files case.
  if [[ "$file_count" == "0" ]]; then
    if [[ -n "$DIFF_RANGE" ]]; then
      echo "warning: no test files matched in diff range '$DIFF_RANGE' — if you expected test changes, verify the range and TEST_FILE_REGEX." >&2
    else
      echo "warning: no test files matched in target '$TARGET_DIR' — verify the path is correct and contains files matching common test patterns (*.test.ts, *.spec.js, *_test.go, etc.)." >&2
    fi
  fi

  # always run config-only checks even if no test files (coverage-regression, snapshot-auto-update)
  IFS=',' read -ra check_list <<< "$CHECKS"
  for check in "${check_list[@]}"; do
    check=$(echo "$check" | xargs)  # trim whitespace
    run_check "$check" "$files"
  done

  if [[ "$JSON" == "1" ]]; then
    emit_json "$file_count"
  else
    emit_human "$file_count"
  fi

  # exit code
  local high_count
  high_count=$(awk -F'\t' '$1=="HIGH"' "$FINDINGS_FILE" | wc -l)
  if [[ "$STRICT" == "1" ]] && [[ "$high_count" -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
