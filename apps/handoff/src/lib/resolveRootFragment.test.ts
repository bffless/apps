// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural validity test for the resolve-root pipeline fragment.
 *
 * The resolve-root group is a reusable 4-step fragment that tasks mint & grants
 * splice into their pipelines. It determines whether a folderId refers to the
 * literal "root" (special case), resolves it to the actual root folder UUID
 * if it exists (or creates it if missing), and returns the resolved UUID and owner.
 *
 * This test asserts the fixture is well-formed so it can be safely imported
 * and spliced by later tasks.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const resolveRootFragment = JSON.parse(
  readFileSync(new URL('../../bffless/_fragments/resolve-root.json', import.meta.url), 'utf8'),
) as Array<Record<string, any>>

describe('resolve-root pipeline fragment', () => {
  it('parses as a JSON array', () => {
    expect(Array.isArray(resolveRootFragment)).toBe(true)
  })

  it('contains exactly 4 steps', () => {
    expect(resolveRootFragment).toHaveLength(4)
  })

  it('has step ids in the expected order', () => {
    const ids = resolveRootFragment.map((s) => s.id)
    expect(ids).toEqual(['resolveRootPre', 'rootRecord', 'rootCreate', 'resolveRootShape'])
  })

  it('every step has a non-empty handlerType and config object', () => {
    for (const step of resolveRootFragment) {
      expect(step.handlerType).toBeTruthy()
      expect(typeof step.handlerType).toBe('string')
      expect(step.config).toBeTruthy()
      expect(typeof step.config).toBe('object')
    }
  })

  it('resolveRootPre is a function_handler with request-parsing code', () => {
    const pre = resolveRootFragment[0]
    expect(pre.id).toBe('resolveRootPre')
    expect(pre.handlerType).toBe('function_handler')
    expect(pre.config.code).toBeTruthy()
    expect(typeof pre.config.code).toBe('string')
    expect(pre.config.code).toContain('isRoot')
  })

  it('rootRecord is a data_query with schemaId and condition', () => {
    const rec = resolveRootFragment[1]
    expect(rec.id).toBe('rootRecord')
    expect(rec.handlerType).toBe('data_query')
    expect(rec.config.schemaId).toBe('1c5d4802-596e-4f50-a08f-c41fb8f9fab0')
    expect(rec.config.condition).toBe('steps.resolveRootPre.isRoot')
  })

  it('rootCreate is a data_create with schemaId, condition, and fields', () => {
    const create = resolveRootFragment[2]
    expect(create.id).toBe('rootCreate')
    expect(create.handlerType).toBe('data_create')
    expect(create.config.schemaId).toBe('1c5d4802-596e-4f50-a08f-c41fb8f9fab0')
    expect(create.config.condition).toContain('steps.resolveRootPre.isRoot')
    expect(create.config.condition).toContain('steps.rootRecord')
    expect(create.config.condition).toContain('!steps.rootRecord[0]')
  })

  it('rootCreate fields include expected node structure', () => {
    const create = resolveRootFragment[2]
    const fields = create.config.fields
    expect(fields.nodeType).toBe('root')
    expect(fields.displayName).toBe('My Files')
    expect(fields.parentId).toBe('')
    expect(fields.mode).toBe('inheriting')
    expect(fields.grantsJson).toBe('[]')
  })

  it('resolveRootShape is a function_handler that outputs effectiveFolderId and rootOwnerId', () => {
    const shape = resolveRootFragment[3]
    expect(shape.id).toBe('resolveRootShape')
    expect(shape.handlerType).toBe('function_handler')
    expect(shape.config.code).toBeTruthy()
    expect(typeof shape.config.code).toBe('string')
    expect(shape.config.code).toContain('effectiveFolderId')
    expect(shape.config.code).toContain('rootOwnerId')
  })
})
