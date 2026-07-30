import type {
  PackageJsonFragment,
  ProjectAnswers,
  ProjectModule,
  RenderedTemplate,
} from '../module-contract.js'
import { WORKSPACE_PACKAGES_DIRECTORY } from '../module-contract.js'

/**
 * The workspace layout — selected when `projectStructure` is `monorepo`.
 *
 * WHAT THIS MODULE DOES AND DOES NOT OWN. It contributes the things that exist ONLY in a workspace: the
 * per-package `package.json`, the vocabulary the other modules' templates branch on, and its own
 * document. It does NOT rewrite the files those other modules own — `tsconfig.json`, `vitest.config.ts`
 * and `bunfig.toml` each branch on `isMonorepo` inside their own template, staying with the module that
 * understands them.
 *
 * That is worth stating because the original plan for this module was a third channel: post-copy file
 * TRANSFORMS, so it could reach into other modules' output and rewrite it. Two earlier changes removed
 * the need. The `packageSource/` copy tree lets a module say which of its files are package-relative,
 * so nothing has to be moved after the fact; and `templateData()` lets this module publish a flag that
 * other modules' templates read, so nothing has to be rewritten after the fact. A transform channel
 * would have been able to corrupt any file in the tree — this arrangement cannot.
 *
 * The root `workspaces` field is not here either: it is written by `renderPackageJson`, because it is
 * structural identity in the same family as `name` and `private`, and because every section a module may
 * contribute is a string map while `workspaces` is an array.
 */
export const monorepoModule: ProjectModule = {
  name: 'monorepo',

  documentation: {
    path: 'docs/monorepo.md',
    title: 'The workspace layout',
    summary:
      'Where source lives, the one alias per package, why test discovery is scoped, and when to reach for a task runner.',
  },

  isSelected(answers: ProjectAnswers): boolean {
    return answers.projectStructure === 'monorepo'
  },

  /**
   * The first package's own `package.json`.
   *
   * Required, not decorative: a directory under `packages/` with no `package.json` is not a workspace
   * member, so the manager ignores it and the single-lockfile-at-the-root arrangement silently does not
   * apply to it.
   *
   * The output path contains an answer, which is the capability the rendered channel has and the copy
   * channel does not — plop renders destination paths as well as contents.
   */
  renderedTemplates(): readonly RenderedTemplate[] {
    return [
      {
        templateFile: 'modules/monorepo/package-package.json.hbs',
        outputPath: `${WORKSPACE_PACKAGES_DIRECTORY}/{{firstPackageName}}/package.json`,
      },
    ]
  },

  /**
   * The flags every other module's template branches on.
   *
   * `isMonorepo` rather than passing `projectStructure` through as a string: Handlebars has no equality
   * helper by default, so `{{#if isMonorepo}}` works while `{{#if (eq projectStructure "monorepo")}}`
   * needs a registered helper. A boolean keeps the templates readable and the failure mode obvious.
   */
  templateData(answers: ProjectAnswers): Readonly<Record<string, unknown>> {
    return {
      isMonorepo: true,
      firstPackageName: answers.firstPackageName,
      workspacePackagesDirectory: WORKSPACE_PACKAGES_DIRECTORY,
    }
  },

  /**
   * Contributes no dependencies. A workspace needs no tooling the single-package layout does not already
   * have — the manager's own `workspaces` support does the linking, and this blueprint has no build step
   * for a task runner to cache.
   *
   * Turborepo and friends are deliberately absent: with one package, no build step, a single `tsc
   * --noEmit` over every package, and one Vitest run producing one aggregated coverage summary, a task
   * runner would have nothing to parallelise and nothing to cache. `docs/monorepo.md` records the
   * threshold at which that stops being true.
   */
  packageJsonFragment(): PackageJsonFragment {
    return {}
  },
}
