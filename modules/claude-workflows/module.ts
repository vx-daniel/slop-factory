import type { PackageJsonFragment, ProjectAnswers, ProjectModule } from '../module-contract.js'

/** The feature checkbox value that selects this module. */
export const CLAUDE_WORKFLOWS_FEATURE = 'claude-workflows'

/**
 * The GitHub Actions workflows that run Claude against a repository — selected by the
 * `claude-workflows` feature checkbox.
 *
 * WHY THIS IS OPT-IN RATHER THAN PART OF `base`. Each requires a `CLAUDE_CODE_OAUTH_TOKEN` repository
 * secret, and each is inert without one. Shipping ~700 lines of workflow YAML that does nothing until
 * the adopter provisions a token is worse than not shipping it: the files read as broken rather than as
 * unconfigured. `secret-scan.yml` stays in `base` for the opposite reason — gitleaks needs no token at all,
 * so it works the moment a project is generated.
 *
 * WHY THEY ARE SELF-CONTAINED rather than thin callers of a shared reusable workflow. They began as ~15-line
 * stubs delegating to an organisation's private repository, which meant every generated project shipped four
 * files that only worked inside that organisation — and whose own comments told everyone else to delete
 * them. Single-sourcing the logic is genuinely better *within* one organisation; it is strictly worse for a
 * generator whose output goes anywhere.
 *
 * WHAT THAT COSTS, stated plainly: the logic can no longer be updated centrally. An improvement made here
 * reaches a project only when someone re-runs the generator and diffs. That is the trade for working at all
 * outside one organisation.
 *
 * Contributes no dependencies and no scripts. These workflows run entirely on GitHub's runners via
 * `anthropics/claude-code-action`; nothing about them is installed locally.
 */
export const claudeWorkflowsModule: ProjectModule = {
  name: 'claude-workflows',

  documentation: {
    path: 'docs/claude-workflows.md',
    title: 'Claude workflows',
    summary: 'The agent workflows, the one secret they need, and what each does when that secret is absent.',
  },

  isSelected(answers: ProjectAnswers): boolean {
    return answers.enableFeatures.includes(CLAUDE_WORKFLOWS_FEATURE)
  },

  /**
   * Lets the generated `CLAUDE.md` and `README.md` mention the one secret these need, and stay silent about
   * it otherwise. A project generated without this feature should carry no reference to a token it has no
   * use for — the previous arrangement told every adopter about an organisation secret and then told them to
   * delete four files.
   */
  templateData(): Readonly<Record<string, unknown>> {
    return { hasClaudeWorkflows: true }
  },

  packageJsonFragment(): PackageJsonFragment {
    return {}
  },
}
