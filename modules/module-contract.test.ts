import { describe, expect, it } from 'vitest'
import {
  mergePackageJsonFragments,
  type PackageJsonFragment,
  renderPackageJson,
  typescriptRunnerPrefix,
} from './module-contract.js'

/** Builds the `{ moduleName, fragment }` pair shape `mergePackageJsonFragments` consumes. */
function contribution(
  moduleName: string,
  fragment: PackageJsonFragment,
): { moduleName: string; fragment: PackageJsonFragment } {
  return { moduleName, fragment }
}

describe('mergePackageJsonFragments', () => {
  it('combines disjoint keys from different modules into one section', () => {
    const merged = mergePackageJsonFragments([
      contribution('gate', { scripts: { lint: 'biome check' } }),
      contribution('base', { scripts: { test: 'vitest run' } }),
    ])

    expect(merged.scripts).toEqual({ lint: 'biome check', test: 'vitest run' })
  })

  it('keeps each section independent, so a key name may repeat across sections', () => {
    const merged = mergePackageJsonFragments([
      contribution('gate', { devDependencies: { typescript: '~7.0.2' } }),
      contribution('config', { dependencies: { zod: '^4.4.3' } }),
      contribution('node', { engines: { node: '>=24' } }),
    ])

    expect(merged.devDependencies).toEqual({ typescript: '~7.0.2' })
    expect(merged.dependencies).toEqual({ zod: '^4.4.3' })
    expect(merged.engines).toEqual({ node: '>=24' })
  })

  it('throws when two modules set the same key to different values', () => {
    const merge = (): PackageJsonFragment =>
      mergePackageJsonFragments([
        contribution('gate', { scripts: { test: 'vitest run' } }),
        contribution('base', { scripts: { test: 'bun test' } }),
      ])

    expect(merge).toThrow(/conflict/)
  })

  it('names both modules and the conflicting key, so the cause is locatable', () => {
    // The whole point of throwing rather than last-write-wins is that the message tells you WHERE to
    // look. A bare "conflict detected" would leave the operator grepping five modules by hand.
    const merge = (): PackageJsonFragment =>
      mergePackageJsonFragments([
        contribution('gate', { devDependencies: { typescript: '~7.0.2' } }),
        contribution('node', { devDependencies: { typescript: '~5.9.3' } }),
      ])

    expect(merge).toThrow(/gate/)
    expect(merge).toThrow(/node/)
    expect(merge).toThrow(/typescript/)
    expect(merge).toThrow(/~7\.0\.2/)
    expect(merge).toThrow(/~5\.9\.3/)
  })

  it('allows two modules to contribute an identical value for the same key', () => {
    // Two modules may legitimately need the same pin. Forcing an artificial single owner would be
    // bookkeeping with no benefit, so an identical duplicate is explicitly not a conflict.
    const merged = mergePackageJsonFragments([
      contribution('gate', { devDependencies: { typescript: '~7.0.2' } }),
      contribution('other', { devDependencies: { typescript: '~7.0.2' } }),
    ])

    expect(merged.devDependencies).toEqual({ typescript: '~7.0.2' })
  })

  it('returns empty sections when no module contributes anything', () => {
    const merged = mergePackageJsonFragments([contribution('base', {})])

    expect(merged.scripts).toEqual({})
    expect(merged.dependencies).toEqual({})
  })
})

describe('renderPackageJson', () => {
  it('puts identity fields before build configuration', () => {
    const rendered = renderPackageJson({
      projectName: 'my-service',
      merged: { scripts: { test: 'vitest run' } },
    })

    const parsed = JSON.parse(rendered)
    expect(Object.keys(parsed).slice(0, 4)).toEqual(['name', 'version', 'private', 'type'])
    expect(parsed.name).toBe('my-service')
  })

  it('marks generated projects private, so publishing is an explicit later decision', () => {
    const parsed = JSON.parse(renderPackageJson({ projectName: 'my-service', merged: {} }))

    expect(parsed.private).toBe(true)
    expect(parsed.type).toBe('module')
  })

  it('omits empty sections rather than emitting an empty object', () => {
    // An empty `"dependencies": {}` reads as "considered and found to need none" — a claim the
    // generator cannot make.
    const rendered = renderPackageJson({
      projectName: 'my-service',
      merged: { scripts: { test: 'vitest run' }, dependencies: {} },
    })

    expect(rendered).not.toContain('dependencies')
    expect(JSON.parse(rendered)).not.toHaveProperty('dependencies')
  })

  it('sorts keys within a section so regeneration is byte-identical', () => {
    const rendered = renderPackageJson({
      projectName: 'my-service',
      merged: { scripts: { typecheck: 'tsc --noEmit', lint: 'biome check', build: 'tsc' } },
    })

    expect(Object.keys(JSON.parse(rendered).scripts)).toEqual(['build', 'lint', 'typecheck'])
  })

  it('produces identical output for identical input', () => {
    const merged = { scripts: { test: 'vitest run' }, dependencies: { zod: '^4.4.3' } }
    const first = renderPackageJson({ projectName: 'my-service', merged })
    const second = renderPackageJson({ projectName: 'my-service', merged })

    expect(first).toBe(second)
  })

  it('ends with a newline so the file is POSIX-clean and diffs do not show a no-newline marker', () => {
    const rendered = renderPackageJson({ projectName: 'my-service', merged: {} })

    expect(rendered.endsWith('}\n')).toBe(true)
  })
})

describe('typescriptRunnerPrefix', () => {
  it('routes Node through tsx, because Node cannot resolve tsconfig paths alone', () => {
    // Bare `node` throws ERR_MODULE_NOT_FOUND on the first `@/*` import, and generated projects ship
    // those aliases — so this prefix is load-bearing, not ceremony.
    expect(typescriptRunnerPrefix('node')).toBe('node --import tsx')
  })

  it('runs Bun directly, since it resolves tsconfig paths natively', () => {
    expect(typescriptRunnerPrefix('bun')).toBe('bun')
  })
})
