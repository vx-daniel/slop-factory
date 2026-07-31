import type { PackageJsonFragment, ProjectAnswers, ProjectModule, RenderedTemplate } from '../module-contract.js'
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
   * One `package.json` per package, from one template.
   *
   * Required, not decorative: a directory under `packages/` with no `package.json` is not a workspace
   * member, so the manager ignores it and the single-lockfile-at-the-root arrangement silently does not
   * apply to it.
   *
   * The output path and the contents both depend on WHICH package this is, and the shared template data
   * is one object seen by every template — so the name travels in the template's own `data`, the channel
   * that exists for exactly this case. The path is built here in TypeScript rather than left as a
   * Handlebars expression, so the directory a file lands in is readable without resolving a template.
   *
   * Only the FIRST package receives any source: `packageSource/` lands in one directory (see
   * `resolveFirstPackageName`). The rest are created as workspace members holding nothing but this file,
   * which is the same shape a single-package workspace with no optional features already produces, and is
   * enough for the root tsconfig, the alias, and test discovery to cover them the moment code arrives.
   */
  renderedTemplates(answers: ProjectAnswers): readonly RenderedTemplate[] {
    return answers.packageNames.map((packageName) => ({
      templateFile: 'modules/monorepo/package-package.json.hbs',
      outputPath: `${WORKSPACE_PACKAGES_DIRECTORY}/${packageName}/package.json`,
      data: { packageName },
    }))
  },

  /**
   * The flags every other module's template branches on.
   *
   * `isMonorepo` rather than passing `projectStructure` through as a string: Handlebars has no equality
   * helper by default, so `{{#if isMonorepo}}` works while `{{#if (eq projectStructure "monorepo")}}`
   * needs a registered helper. A boolean keeps the templates readable and the failure mode obvious.
   *
   * `packageNames` is the whole list rather than the first name, because the one template that reads it —
   * `tsconfig.json`'s `paths` — needs an entry per package. Templates wanting the first package's paths in
   * prose read `sourceDirectory` and `importAliasPattern` from `base` instead; those have a correct value
   * under both layouts, which this module cannot supply because it is absent under `single`.
   */
  templateData(answers: ProjectAnswers): Readonly<Record<string, unknown>> {
    return {
      isMonorepo: true,
      packageNames: answers.packageNames,
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
