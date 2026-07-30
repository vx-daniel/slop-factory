// Reads coverage/coverage-summary.json (vitest's `json-summary` reporter) and
// writes a committable COVERAGE.md at the repo root: totals, a by-directory
// roll-up, and a "files below threshold" table so attention goes where it's low.
//
// Run after `vitest run --coverage` (the `coverage` npm script chains them).
// With `--readme`, instead injects the totals table into the marker block in
// README.md (between <!-- COVERAGE-START --> and <!-- COVERAGE-END -->).
//
// COVERAGE.md lives at the repo root (committable) rather than under coverage/
// (gitignored). Its "full HTML report" link points into the gitignored coverage/
// dir, so it resolves only on a local checkout that has run coverage.
//
// Invoked through `tsx` by the npm scripts, never as a bare executable — hence no
// shebang. See README.md § "Running TypeScript directly on Node".

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const REPO_ROOT = process.cwd()
const SUMMARY_PATH = resolve(REPO_ROOT, 'coverage', 'coverage-summary.json')
const OUTPUT_PATH = resolve(REPO_ROOT, 'COVERAGE.md')
const README_PATH = resolve(REPO_ROOT, 'README.md')
const HTML_REPORT_LINK = './coverage/index.html'

// Files with line coverage below this get listed explicitly for attention.
const LOW_COVERAGE_LINE_PCT = 70
// Multiplier turning a covered/total ratio into a percentage.
const PERCENTAGE_SCALE = 100
const README_MARKER_START = '<!-- COVERAGE-START -->'
const README_MARKER_END = '<!-- COVERAGE-END -->'

const METRICS = ['lines', 'statements', 'functions', 'branches'] as const
type MetricName = (typeof METRICS)[number]

const EXIT_FAILURE = 1

/**
 * A percentage as the v8 provider actually emits it. The `'Unknown'` arm is not defensive typing:
 * when a metric has nothing to cover, v8 writes the literal STRING `"Unknown"` rather than 0 or NaN.
 * Modelling it in the type forces every read site to handle the case that previously crashed
 * `formatPct` on a brand-new project's first `npm run coverage`.
 */
type CoveragePercentage = number | 'Unknown'

/** One metric's counts within a coverage summary entry. */
interface CoverageMetric {
  readonly total: number
  readonly covered: number
  readonly skipped?: number
  readonly pct: CoveragePercentage
}

/** One file's (or the `total` roll-up's) summary — one {@link CoverageMetric} per metric. */
type CoverageEntry = Record<MetricName, CoverageMetric>

/** `[repo-relative path, summary]` for a single covered file. */
type FileEntry = readonly [string, CoverageEntry]

/** Mutable per-directory accumulator used while summing counts in {@link rollUpByDirectory}. */
type DirectoryTotals = Record<MetricName, { covered: number; total: number; pct: number }>

/** One directory's roll-up row. */
interface DirectoryRollUp {
  readonly directory: string
  readonly metrics: DirectoryTotals
}

/** The parsed coverage summary: the `total` entry plus one entry per file. */
interface CoverageData {
  readonly total: CoverageEntry
  readonly fileEntries: readonly FileEntry[]
}

/** Identifying stamp for a generated document, so two runs of the same coverage compare equal. */
interface DocumentStamp {
  readonly commitSha: string
  readonly generatedAtIso: string
}

/**
 * Format a percentage to one decimal place with a trailing `%`.
 *
 * Renders a non-numeric percentage as `—` rather than throwing — see {@link CoveragePercentage} for
 * why `pct` is not always a number. `—` also matches how `directoryTable` renders a zero-total
 * metric, so "no coverable code" reads the same everywhere in the document.
 */
function formatPercentage(value: CoveragePercentage): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—'
  }
  return `${value.toFixed(1)}%`
}

/** Resolve the current short git SHA, or `unknown` outside a git work tree. */
function currentGitSha(): string {
  try {
    // stderr is piped, not inherited: outside a work tree (a fresh clone of the blueprint before
    // `git init`, or a CI checkout without history) git writes "fatal: Needed a single revision" to
    // the terminal. The catch below already handles it — printing the fatal makes a handled case
    // look like a failed run.
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

/** Build a one-row-per-metric markdown table from a coverage summary entry. */
function metricsTable(entry: CoverageEntry): string {
  const rows = METRICS.map((metric) => {
    const { covered, total, pct } = entry[metric]
    return `| ${metric} | ${formatPercentage(pct)} | ${covered}/${total} |`
  })
  return ['| Metric | % | Covered/Total |', '|---|---|---|', ...rows].join('\n')
}

/**
 * Aggregate per-file summaries into per-directory totals, recomputing each percentage from summed
 * covered/total counts. Summing the counts and dividing once is deliberate — averaging the per-file
 * percentages would weight a 3-line file the same as a 300-line one.
 */
function rollUpByDirectory(fileEntries: readonly FileEntry[]): DirectoryRollUp[] {
  const metricsByDirectory = new Map<string, DirectoryTotals>()
  for (const [relativePath, summary] of fileEntries) {
    const directory = `${dirname(relativePath)}/`
    let directoryTotals = metricsByDirectory.get(directory)
    if (directoryTotals === undefined) {
      directoryTotals = Object.fromEntries(
        METRICS.map((metric) => [metric, { covered: 0, total: 0, pct: 0 }]),
      ) as DirectoryTotals
      metricsByDirectory.set(directory, directoryTotals)
    }
    for (const metric of METRICS) {
      directoryTotals[metric].covered += summary[metric].covered
      directoryTotals[metric].total += summary[metric].total
    }
  }
  for (const directoryTotals of metricsByDirectory.values()) {
    for (const metric of METRICS) {
      const { covered, total } = directoryTotals[metric]
      // total === 0 means the directory has no coverable code (pure re-exports).
      // Leave pct at 0; `directoryTable` renders these as `—` (not a fake 100%,
      // which contradicted the below-threshold table for the same files).
      directoryTotals[metric].pct = total === 0 ? 0 : (covered / total) * PERCENTAGE_SCALE
    }
  }
  return [...metricsByDirectory.entries()]
    .sort(([leftDirectory], [rightDirectory]) => leftDirectory.localeCompare(rightDirectory))
    .map(([directory, metrics]) => ({ directory, metrics }))
}

/** Render the by-directory roll-up as a markdown table (lines % is the headline column). */
function directoryTable(rows: readonly DirectoryRollUp[]): string {
  const header = ['| Directory | Lines | Statements | Functions | Branches |', '|---|---|---|---|---|']
  // A metric with no coverable code (total 0 — e.g. a re-export-only dir) renders
  // as `—` rather than a percentage, so it never reads as fully/zero covered.
  const cell = (metric: { total: number; pct: number }): string =>
    metric.total === 0 ? '—' : formatPercentage(metric.pct)
  const body = rows.map(
    ({ directory, metrics }) =>
      `| \`${directory}\` | ${cell(metrics.lines)} | ${cell(metrics.statements)} | ` +
      `${cell(metrics.functions)} | ${cell(metrics.branches)} |`,
  )
  return [...header, ...body].join('\n')
}

/**
 * Numeric view of a percentage, for comparison and sorting.
 *
 * `'Unknown'` becomes 0. That is only safe because every call site excludes zero-total metrics
 * first, and zero total is the sole condition under which v8 emits `'Unknown'` — so the 0 is never
 * actually compared. Without this helper the comparison silently coerced to `NaN`, and every
 * `NaN < threshold` test is `false`: an unmeasurable file would have been quietly dropped by an
 * accident of coercion rather than by the explicit guard below.
 */
function percentageAsNumber(value: CoveragePercentage): number {
  return typeof value === 'number' ? value : 0
}

/** Render the "files below the line-coverage threshold" table, lowest first. */
function belowThresholdTable(fileEntries: readonly FileEntry[]): string {
  const lowCoverageFiles = fileEntries
    // `lines.total > 0` excludes re-export-only files: vitest reports 0 coverable lines for them,
    // and they have nothing to cover — not under-tested. (This is what made them contradict the
    // directory roll-up.) It is also what guarantees `pct` is a real number below.
    .filter(([, summary]) => summary.lines.total > 0 && percentageAsNumber(summary.lines.pct) < LOW_COVERAGE_LINE_PCT)
    .sort(
      ([, leftSummary], [, rightSummary]) =>
        percentageAsNumber(leftSummary.lines.pct) - percentageAsNumber(rightSummary.lines.pct),
    )
  if (lowCoverageFiles.length === 0) {
    return `_No files below ${LOW_COVERAGE_LINE_PCT}% line coverage._`
  }
  const header = ['| File | Lines | Branches |', '|---|---|---|']
  const body = lowCoverageFiles.map(
    ([path, summary]) =>
      `| \`${path}\` | ${formatPercentage(summary.lines.pct)} | ${formatPercentage(summary.branches.pct)} |`,
  )
  return [...header, ...body].join('\n')
}

/**
 * Load the coverage summary, exiting with an actionable message if it's absent (i.e.
 * `vitest run --coverage` hasn't been run yet).
 *
 * The parsed JSON is asserted to {@link CoverageEntry} rather than schema-validated: this file is
 * generated by vitest moments earlier in the same npm script, so it is not a trust boundary in the
 * sense `zod-schemas.md` governs. A malformed summary means the coverage provider is broken, which
 * is not a case this script can meaningfully recover from.
 */
function loadSummary(): CoverageData {
  if (!existsSync(SUMMARY_PATH)) {
    process.stderr.write(
      `coverage-to-markdown: ${relative(REPO_ROOT, SUMMARY_PATH)} not found. ` +
        `Run \`npm run coverage\` first (it generates the json-summary).\n`,
    )
    process.exit(EXIT_FAILURE)
  }
  const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8')) as Record<string, CoverageEntry>
  const fileEntries: FileEntry[] = Object.entries(summary)
    .filter(([key]) => key !== 'total')
    .map(([absolutePath, value]) => [relative(REPO_ROOT, absolutePath), value] as const)
  return { total: summary.total, fileEntries }
}

/** Build the full COVERAGE.md document body. */
function buildDocument(data: CoverageData, stamp: DocumentStamp): string {
  return [
    '# Test Coverage',
    '',
    `_Generated ${stamp.generatedAtIso} at \`${stamp.commitSha}\` — do not edit by hand; run \`npm run coverage\`._`,
    '',
    '## Totals',
    '',
    metricsTable(data.total),
    '',
    '## By directory',
    '',
    directoryTable(rollUpByDirectory(data.fileEntries)),
    '',
    `## Files below ${LOW_COVERAGE_LINE_PCT}% line coverage`,
    '',
    belowThresholdTable(data.fileEntries),
    '',
    '---',
    '',
    `[Full HTML report →](${HTML_REPORT_LINK}) _(local only; the \`coverage/\` dir is gitignored)_`,
    '',
  ].join('\n')
}

/**
 * Inject the totals table into README.md between the marker comments. Exits with an actionable
 * message if the markers are missing.
 */
function updateReadme(total: CoverageEntry, stamp: DocumentStamp): void {
  const readme = readFileSync(README_PATH, 'utf8')
  const startIndex = readme.indexOf(README_MARKER_START)
  const endIndex = readme.indexOf(README_MARKER_END)
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    process.stderr.write(
      `coverage-to-markdown: README markers not found. Add a block bounded by ` +
        `${README_MARKER_START} and ${README_MARKER_END} where the totals should go.\n`,
    )
    process.exit(EXIT_FAILURE)
  }
  const block = [
    README_MARKER_START,
    '',
    `_Coverage at \`${stamp.commitSha}\` (${stamp.generatedAtIso}) — see [COVERAGE.md](./COVERAGE.md)._`,
    '',
    metricsTable(total),
    '',
    README_MARKER_END,
  ].join('\n')
  const updated = readme.slice(0, startIndex) + block + readme.slice(endIndex + README_MARKER_END.length)
  writeFileSync(README_PATH, updated)
  process.stdout.write(
    `coverage-to-markdown: README.md totals block updated (${formatPercentage(total.lines.pct)} lines).\n`,
  )
}

/**
 * Drop the one volatile line (`_Generated <timestamp> at <sha>_`) so two documents built from
 * identical coverage but at different times/commits compare equal. Everything else in the document
 * is deterministic from the coverage data.
 */
function withoutVolatileHeader(documentBody: string): string {
  return documentBody
    .split('\n')
    .filter((line) => !line.startsWith('_Generated '))
    .join('\n')
}

/**
 * `--check` mode: fail when the committed COVERAGE.md does not match a freshly-built document
 * (ignoring the volatile header). This is a manual/local drift check — it is NOT wired into the PR
 * gate. COVERAGE.md is regenerated + committed by the push-to-main job
 * (.github/workflows/coverage-main.yml); the per-PR gate no longer freshness-checks it (that caused
 * serial COVERAGE.md merge conflicts between in-flight PRs). To refresh locally: `npm run coverage`.
 */
function checkInSync(data: CoverageData, stamp: DocumentStamp): void {
  if (!existsSync(OUTPUT_PATH)) {
    process.stderr.write('coverage-to-markdown: COVERAGE.md not found — run `npm run coverage` and commit it.\n')
    process.exit(EXIT_FAILURE)
  }
  const expected = buildDocument(data, stamp)
  const committed = readFileSync(OUTPUT_PATH, 'utf8')
  if (withoutVolatileHeader(committed) !== withoutVolatileHeader(expected)) {
    process.stderr.write(
      'coverage-to-markdown: COVERAGE.md is out of sync with actual coverage. ' +
        'Run `npm run coverage` and commit the updated COVERAGE.md.\n',
    )
    process.exit(EXIT_FAILURE)
  }
  process.stdout.write('coverage-to-markdown: COVERAGE.md in sync.\n')
}

const data = loadSummary()
const stamp: DocumentStamp = {
  commitSha: currentGitSha(),
  generatedAtIso: new Date().toISOString(),
}

if (process.argv.includes('--readme')) {
  updateReadme(data.total, stamp)
} else if (process.argv.includes('--check')) {
  checkInSync(data, stamp)
} else {
  writeFileSync(OUTPUT_PATH, buildDocument(data, stamp))
  process.stdout.write(
    `coverage-to-markdown: wrote ${relative(REPO_ROOT, OUTPUT_PATH)} ` +
      `(${formatPercentage(data.total.lines.pct)} lines).\n`,
  )
}
