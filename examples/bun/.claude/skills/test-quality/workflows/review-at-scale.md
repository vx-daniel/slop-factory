# Workflow: Review at scale

Use this workflow when auditing more than one test file — a full test directory, a suite of N files, a whole package's tests. The single-file review workflow doesn't scale past ~5 files; mental mutation discipline applied N times serially exhausts context before useful synthesis.

If you're reviewing 1 file or 1 PR, load `workflows/review-single.md` instead.

## Output shape

A scale audit produces a structured deliverable, not running prose. The shape:

- **Verdict by region** (table: region → verdict → headline risk)
- **Findings ranked by severity** (S1, S2, S3... — receipts-backed with file:line)
- **What I'm explicitly NOT flagging** (calibrates signal-to-noise; lists what looked smelly but isn't)
- **Recommended follow-ups** (prioritized menu, not committed scope)
- **Verification section** (cross-check instructions for the human reader)

The deliverable goes to a file (`.local/spikes/test-quality-audit.md` or similar) — not as a PR comment, not as inline edits. A scale audit is read-only by design; the output is a menu of issues to file, not changes to make.

## Procedure

### Step 1 — Tier 1 grep pass

Run the bundled script. Cheap, fast, catches deterministic signals.

```bash
./scripts/check-test-quality.sh path/to/tests --json > /tmp/grep-findings.json
```

Read the output. Note the counts by severity. **The grep pass is calibration data, not the audit itself.** If `< 5` HIGH findings in 50+ files, evasion isn't the dominant failure mode for this codebase. If `> 20` HIGH findings in 50 files, evasion IS the dominant failure mode — focus the rest of the audit on those signals.

What the grep pass cannot catch (and what the rest of this workflow does catch):
- "The only assertion is `toBeDefined()`" — requires test block scope understanding
- Mock setup proportions — requires AST parsing
- Test names that describe implementation, not behavior — requires semantic judgment
- "Test would not catch a realistic mutation" — requires understanding the SUT
- **Assertion permissiveness on contract surfaces** (`toMatchObject` everywhere on a public-API library) — requires understanding what's a contract

### Step 2 — Identify the contract surface

Before regioning the suite, identify what *kind* of code it tests. The dominant risk shape determines which checklists and references to load.

| Code under test | Dominant risk | Load |
|---|---|---|
| Public-API library with **enumerable structural output** (decoders, parsers, serializers, encoders, format converters, codecs) | Structural-contract drift + invariant violations on inputs the test suite didn't think to enumerate | `references/assertion-shape.md` + see "Structural-contract domains" note below |
| Public-API library with **discrete output** (formatters, normalizers, getters returning specific types) | Assertion permissiveness on output shape | `references/assertion-shape.md` |
| Code that talks to external services (HTTP, DB, file system) | Mock anti-patterns | `checklists/mock-antipatterns.md` |
| Pure logic (algorithms, validators, transformers) | Tautological / edge-case-gap tests | Apply mental mutation per Section 3 below |
| Internal helpers / pure functions with no public contract | Edge-case-gap and tautology only — **do NOT load assertion-shape.md**, the contract lens is the wrong lens here | Skip contract-shape checks; focus on mental mutation and edge coverage |
| Mixed | Likely all three — load everything | All above |

**Structural-contract domains.** When the code under test is a parser, decoder, serializer, encoder, format converter, or other structural transformer (input bytes/string/object → output structured representation), **property-based testing is the primary discipline, not advisory**. Unit tests with example inputs miss bugs that property-based tests catch structurally:

- Round-trip invariants: `decode(encode(x)) == x` for all valid `x`
- Bounded-length invariants: output size is a function of input size
- Type-shape invariants: output always has fields `{a, b, c}` regardless of which input branch was taken
- Idempotence: `normalize(normalize(x)) == normalize(x)`

For these codebases, the audit's secondary deliverable should name the missing property tests, not just the missing canonical-shape locks. Tools: `fast-check` (JS/TS), `hypothesis` (Python), `proptest` (Rust), `Hedgehog` (Haskell). Without them, edge-case coverage is necessarily incomplete; you're sampling the input space, not characterizing it.

This is the contract lens the skill defaults to for "decoders" but doesn't fully apply. Example self-application: a decoder-only library (no encode function — input bytes → output JSON, no inverse) cannot rely on a round-trip property, but the **type-shape invariant** still applies: "for any valid input byte sequence, `decode(payload)` returns an object whose top-level fields and types match the documented schema, regardless of byte values." That property, expressed as a fast-check generator, would have caught DataType-level fig-leaves that the assertion-shape lens (per-example `toEqual`) does not. Pick the invariant that fits the code's actual direction; round-trip is paradigmatic but not universal.

**Mixed codebases** (e.g., a parser library that also contains formatters, validators, and pure helpers) cannot be categorized whole-codebase. Categorize per-module: parsers/encoders → structural-transformer lens; helpers → pure-logic lens; etc. The contract-surface table above is a per-region or per-module decision, not a one-time top-level call.

The contract surface is the analytical lens. Without it, you'll flag generic smells; with it, you'll surface structural risks.

### Step 2.5 — Read recent commits as a lens

Before regioning, read recent git history (last ~3 months on the active branch) looking specifically for:

- **Bug-fix commits** that touched the code under test. Each one represents a class of bug the suite shipped at least once. The audit's job is to find adjacent unguarded code in the same class.
- **Reverts** of changes that broke production. These signal the test suite did not catch a real regression.
- **Commits referenced in TODO/FIXME comments** as "fix later" — investigation may find adjacent unguarded code.
- **Recent migrations / refactors** that touched many files. Often expose gaps where one file got the new pattern but adjacent files did not.

Practical commands:

```bash
# bug-fix commits touching the source dir under test
git log --oneline --since='3 months ago' --grep='fix\|bug\|regression' -- src/

# files most-changed recently (regression-prone hot spots)
git log --since='3 months ago' --name-only --pretty=format: -- src/ | sort | uniq -c | sort -rn | head -20

# what specific code was touched in a given bug-fix commit
git show <commit-sha> -- src/
```

**Use the bug-fix commits as the lens for the audit's strongest findings.** Two example shapes:

- **Decoder-library codebase**: if commit `abc123` fixed an int16 sign bug in one DataType module, search the audit for adjacent DataType modules that share the same code shape but did not receive the fix. Those are **S1-class findings** — direct precedent, not speculation.
- **Web app / API codebase**: if commit `def456` fixed a SQL-injection in `/api/users` by switching to parameterized queries, grep adjacent route handlers in `/api/*.ts` for the same query-building pattern. Same class, same fix needed, same S1-class shape.

The pattern generalizes: any recent bug fix is a precedent for finding adjacent unguarded code in the same class. Frontend/CSS regressions, performance bugs, race conditions, schema-drift fixes — all carry the same shape. Bug fix in module A = adjacent-module check across A's neighbors.

This technique is what turns a generic test-quality audit into a regression-precedent audit:
- Generic audit: "tests are weak here."
- Precedent audit: "this exact bug class shipped recently in commit `abc123`; here's the adjacent code that's one mutation away from the same bug, and the test that would have caught it doesn't exist."

Carry the list of recent-bug-class precedents into the reader prompts (Step 4) so each reader is looking for class-specific gaps, not just generic smells. Findings backed by commit-SHA precedent are the audit's most actionable output.

### Step 3 — Region the suite

Partition the test directory into regions of related concern. A region is a coherent slice you can hand to one reader-agent. Common partitions:

- Per-directory (the natural code organization)
- Per-feature (e.g., "all decoder tests" vs "all transport tests")
- Per-layer (data types vs decoders vs runtime)
- By contract surface (public-API tests vs internal-helper tests)

Aim for 2-4 regions, each containing 5-20 files. More than 4 readers fragments synthesis; fewer than 2 means there's no real scale problem and `review-single.md` would suffice.

### Step 4 — Dispatch readers in parallel

For each region, dispatch one Explore agent (or equivalent reader) with the same prompt template. Parallel dispatch is critical — serial reads exhaust context before synthesis.

**Reader prompt template (use verbatim, adapted only for `<region>` and `<contract surface>`):**

```
Read the test files in <region>. <count> files total.

For each file, answer in one line:
1. What bug would each test catch? If you can't state it in one sentence
   per test, mark the file as containing decorative tests.
2. Is the assertion shape appropriate for the contract surface
   (<contract surface from Step 2>)? Flag toMatchObject usage on
   public output shapes, existence-only assertions, tautologies.
3. Sample 2 tests per file. For each, mentally mutate the implementation
   (return null, return [], flip a comparison, off-by-one). Does any
   test in the file catch the mutation?

Report findings with file:line citations. Format:
- File: <path>
- Headline risk: <one line>
- Specific findings: <list with file:line, each labeled S1, S2, or S3>
- Strength worth noting: <one line, if any>

**Severity labels: use ONLY S1, S2, or S3.** Do not invent S4/S5/etc.
- S1 = must fix or known evasion (regression precedent, hard contract violation)
- S2 = structural risk worth filing (cross-cutting, but not active regression)
- S3 = smell worth tracking (per-file, advisory)

**Before claiming a mock anti-pattern (from checklists/mock-antipatterns.md),
quote the exact `file:line` showing the mock setup (`vi.mock`, `jest.mock`,
`mock.module`, `vi.fn()`, manual mock object, etc.).** If you cannot quote a
mock-setup line, the finding is not a mock anti-pattern — it is likely the
canonical-lock theme (permissive assertions) or a related shape concern. Do
not call something a mock anti-pattern based on "looks evasive" alone.

**Demonstrate reference loading: if you used `references/assertion-shape.md`
or `references/<framework>-patterns.md`, quote one sentence from each
reference you actually consulted.** Saying "per assertion-shape.md" without a
verbatim quote suggests training-data priors rather than the loaded
reference; that's a calibration risk for the audit.

Under 600 words total. Calibrated, not exhaustive — the audit's job is
to surface real issues, not catalog every smell.

Skip files matching:
- Tests of generated code (snapshots, codegen outputs)
- Tests explicitly marked as integration / e2e where the audit lens differs

Use the principles in test-quality/SKILL.md and the patterns in
checklists/fig-leaf-signals.md, checklists/mock-antipatterns.md, and (if
loaded) references/assertion-shape.md.
```

Dispatch all readers in a single message (parallel tool calls). Wait for all to return before synthesizing.

### Step 5 — Synthesize

Collect reader outputs. Synthesis is the audit's main intellectual work; readers gather receipts, the orchestrator ranks and structures.

**Severity translation.** The Tier 1 script outputs `HIGH/MEDIUM/LOW` (detection confidence). The audit deliverable uses `S1/S2/S3` (consequence: blast radius × likelihood). These axes are not the same — a script LOW can be an S1 if the consequence is severe; a script HIGH can be S3 if the consequence is contained. See `scripts/README.md` "Severity vocabulary" for the full translation rule. When citing Tier 1 results in the deliverable, keep HIGH/MEDIUM/LOW verbatim. When listing the audit's own findings, use S1/S2/S3. Don't mix or collapse.

**Rank findings by (blast radius × likelihood):**

- **Blast radius**: how many users / how much code is at risk if this defect ships? Public-API drift > internal helper bug.
- **Likelihood**: how often would the failure mode trigger in practice? Snapshot regenerated without inspection = high; weak edge-case-only test = lower.

S1 / S2 / S3 severity labels emerge from this ranking. S1 = "must fix or known evasion"; S2 = "structural risk worth filing"; S3 = "smell worth tracking".

**Group findings by type when there's a pattern.** If 12 files all use `toMatchObject` on contract output, that's *one* finding (S2) with 12 instances cited, not 12 findings.

**Calibrate signal-to-noise.** The "what I'm NOT flagging" section is mandatory. List what the audit *could* have flagged but chose not to — `.skip` count, mock complexity, etc. This proves the audit is selective rather than blanket-condemnatory and helps the human reader trust the S-ranked findings.

### Step 6 — Write the deliverable

The output goes to a file. Sections (in order):

```markdown
# Test-Quality Audit — <path or scope>

## Context
Why this audit was triggered; what code under test produces; what
the dominant risk shape is (from Step 2).

## Verdict by region
| Region | Verdict | Headline risk |
| ...    | ...     | ...           |

## Findings, ranked by severity
### S1 — <headline>
**Files:** <path>:<line>, <path>:<line>
<receipt-quoted code if useful>
<why this is a finding>
**Fix direction (follow-up issue):** <one paragraph>

### S2 — <headline>
...

## What I'm explicitly **not** flagging
- <pattern that's present but not problematic in context>
- <smell that the contract surface forgives>

## Recommended follow-ups (file as separate issues)
1. <highest priority>
2. <next>
...

## Verification
For each S-level finding above, open the cited file:line and confirm
the quoted assertion matches what's there. Run `<test command>` once
to confirm the suite currently passes — establishes the baseline.
Before filing each follow-up issue, grep the codebase to scope the
work.

## Critical files referenced
<flat list of every file:line cited above>
```

## Discipline reminders

- **Read-only.** The audit produces a menu of issues, not code changes. If you find yourself drafting fixes, stop and capture them as "fix directions" in the follow-up section.
- **No fix is in scope without explicit owner sign-off.** Even if a fix looks obvious, scale audits don't make changes. The owner decides scope after seeing the menu.
- **Calibrate aggressively.** A finding that looks like a smell but is justified by context is not a finding — list it in "what I'm not flagging."
- **Cite, don't paraphrase.** Every S-level finding cites `file:line`. The human reader cross-checks; the agent doesn't get believed on prose alone.

## When this workflow is the wrong tool

- **1-5 files**: load `workflows/review-single.md` instead. Scale dispatch is overhead for small reviews.
- **You're writing tests, not reviewing**: load `workflows/generate.md`.
- **A specific test is failing now**: load `workflows/maintain-failing.md`. Don't audit the whole suite; fix the failing thing first.
- **You're reviewing a single PR's added/modified tests**: load `workflows/review-single.md`. PR-scope review is single-region by definition.

## Cross-references

- Principles and router: `SKILL.md`
- Detection patterns the readers should know: `checklists/fig-leaf-signals.md`
- Mock-specific patterns: `checklists/mock-antipatterns.md`
- Assertion permissiveness (contract libraries): `references/assertion-shape.md`
- Framework-specific pitfalls: `references/vitest-patterns.md`, `references/bun-test-patterns.md`
- Tier 1 grep script: `scripts/check-test-quality.sh`
