---
always_on: false
applies_to: writing or reviewing a test that asserts on the CONTENT of a generated file
---

# Asserting on File Content

## Enforcement

**Review-only.** No gate is possible, and that is a property of the problem rather than a gap in the
tooling: whether `expect(text).toContain('packages')` is checking data or accidentally matching prose
depends on what the file's comments happen to say. A linter would have to read the file under test.

The compensating control is the **mutation requirement** below, which is mechanical even though the rule
is not.

## The principle

An assertion about a file's content must match that file's **data**, never its **prose**.

Every file this factory generates carries explanatory comments — that is required by `the-posture`
(comments carry WHY) and by the shipped `naming-and-style.md`. Those comments legitimately name the
alternatives the file did not take: `ci.yml` explains how the other package managers differ, `tsconfig.json`
explains what the other layout does. So the vocabulary a test wants to assert on is *also* present in the
surrounding explanation, and a substring match cannot tell the two apart.

## Why this is not a small problem

It fails in **both directions**, from the same root cause, and only one is loud.

| Direction | What happens | Cost |
|---|---|---|
| **False positive** | The test fails against correct code, because the forbidden token appears in a comment | Noisy. You lose time, then fix the assertion. |
| **False negative** | The test passes against broken code, because the expected token appears in a comment | **Silent.** The guard reports green forever. |

The false negative is the one that matters, and it is the reason this rule exists rather than being left
to taste. See incident 2 below: a guard added specifically to prevent a config from drifting **did not
fail when the config was broken**, because the config's own comment named the thing the guard searched
for. It was written, reviewed, and green — and worthless.

## How to apply — in preference order

**1. Parse the data.** Strongest, when the format allows it cheaply.

```ts
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { scripts: Record<string, string> }
expect(packageJson.scripts.test).toContain('--dir packages')
```

Comments cannot reach `packageJson.scripts`. Prefer this whenever the file is real JSON. It does not work
for JSON-with-comments (`tsconfig.json`, `biome.jsonc`) without a tolerant parser, which is usually more
machinery than the check is worth.

**2. Filter to the lines that carry data,** then assert on those.

```ts
// Only the `run:` lines. The comments legitimately NAME the other package managers when explaining
// the difference between them — asserting against the whole file made this test fail on its own docs.
const executedCommands = workflow.split('\n').filter((line) => /^\s*run:/.test(line)).join('\n')
```

Name the predicate for what it selects (`commandsExecutedBy`), not how it selects it. The filter is the
assertion's subject; burying it in a regex at the call site hides what is being checked.

**3. Match a form that prose cannot produce.** Weakest of these, but often the only option for
config-with-comments.

```ts
// The QUOTES are the whole point: a glob only counts as configuration when it appears as a JSON string.
expect(configContents).toContain(`"modules/*/${copyTreeDirectoryName}"`)
```

Comments in this codebase quote identifiers with backticks, so requiring double quotes distinguishes
configuration from explanation. This is deliberately **stricter than the format allows** — a
semantically-equivalent entry written differently will fail it. Accept that: a false positive fails
loudly and is a one-line fix, where the false negative it replaces was silent. Say so in the comment, so
the next reader does not "helpfully" loosen it.

## The mutation requirement

**A guard of this kind is not done until you have watched it fail.** Break the thing it guards, run it,
see red, restore.

This is not general advice about testing — it is specific to this failure mode, because a
prose-matching assertion is *indistinguishable from a working one* when everything is green. Incident 2
was caught only by this step, and incident 3 was caught only because the assertion happened to fail
immediately.

State the mutation in the comment or the commit, so a reviewer knows it was done rather than claimed.

## What you must NOT do

**Do not delete or reword the comment to make the assertion work.** The comment is the file's WHY, it
ships to a real reader, and `the-posture` ranks it above the convenience of a test. The assertion is what
is wrong in this situation, every time.

Do not reach for `not.toContain(<bare word>)` on a documented file at all. If a word is worth forbidding,
some structural form of it is what you actually mean.

## Evidence — three incidents, one session

All three are in this repository, all found while adding pnpm and the monorepo layout.

**1. `tests/generation.test.ts` — the CI install command.** Asserting the whole `ci.yml` did not contain
a rival manager's name failed against a correct workflow, because the template's comments explain how the
managers differ. *False positive.* Fixed by filtering to `run:` lines. Compounded by a second trap in the
same assertion: `npm` is a substring of `pnpm`, so the check tripped on pnpm's own correct install line —
which is why it now discriminates on the three install commands, verified pairwise non-substring.

**2. `modules/module-sources.test.ts` — the copy-tree config guard.** A guard asserting that
`tsconfig.json`, `tsconfig.build.json` and the linter config each exclude every module copy tree searched
for the bare glob `modules/*/packageSource`. Deleting the real exclude entry **did not fail the test** —
the string was present in the comment explaining the exclusion. *False negative, caught only by mutation
testing.* Fixed by requiring the quoted form.

That same guard caught a second mistake later, which is the shape working as intended: swapping the linter
config from `.oxlintrc.json` to `biome.jsonc` failed it, because Biome **negates** inside `files.includes`
(`"!modules/*/source"`) where tsconfig **lists** in `exclude` (`"modules/*/source"`). The fix was to carry
the expected prefix per config rather than loosening the match — loosening is what re-admits the prose.

**3. `tests/layout.test.ts` — workspace globs.** `not.toContain('packages')`, asserting a single-package
project has no workspace vocabulary, matched the word inside a comment describing what the workspace
layout does differently. *False positive.* Fixed by requiring quoted forms.

## This rule is a hypothesis

Per `the-posture`, every rule here is revisable. What would tell us this one is wrong:

- **If it stops earning its keep** — no occurrence in a long stretch of work touching generated-file
  assertions — it is over-fitted to one session and should shrink to a comment in the affected tests.
- **If the fix keeps not sticking** — a fourth and fifth incident *after* this rule exists — then the
  rule is not the right intervention and the real answer is structural: a shared
  `dataLinesOf(file, format)` helper that tests cannot bypass, or generating the assertions from the
  module contract rather than from file text.
- **If the same trap appears inside a generated project** rather than in the factory's tests, the scope
  below is wrong and this belongs in `modules/base/source/.claude/rules/` where it ships to adopters.

## Scope

**The factory's own tests only.** It is deliberately NOT shipped to generated projects: all three
incidents are factory test code asserting on generated output, and a generated project rarely greps its
own config. Shipping it would broaden the claim past its evidence, which the `broken-windows.md` this
factory ships explicitly warns against.
