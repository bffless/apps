import { describe, it, expect } from 'vitest'
import { evaluatePublicServe, PUBLIC_SERVE_MAX_BYTES } from './publicServe'

function fileNode(over: Record<string, unknown> = {}) {
  return { nodeType: 'file', public: true, size: 1024, ...over }
}

describe('evaluatePublicServe', () => {
  it('allows an explicitly-public small file', () => {
    expect(evaluatePublicServe({ node: fileNode() })).toEqual({ allow: true, deny: false })
  })

  it('denies a node that is not flagged public (private by default)', () => {
    expect(evaluatePublicServe({ node: fileNode({ public: false }) })).toEqual({
      allow: false,
      deny: true,
    })
    expect(evaluatePublicServe({ node: fileNode({ public: undefined }) })).toEqual({
      allow: false,
      deny: true,
    })
  })

  it('accepts the string "true" the data layer may round-trip', () => {
    expect(evaluatePublicServe({ node: fileNode({ public: 'true' }) }).allow).toBe(true)
  })

  it('treats any other truthy-looking value as not public', () => {
    expect(evaluatePublicServe({ node: fileNode({ public: 1 }) }).allow).toBe(false)
    expect(evaluatePublicServe({ node: fileNode({ public: 'yes' }) }).allow).toBe(false)
  })

  it('denies when there is no matching node', () => {
    expect(evaluatePublicServe({ node: null })).toEqual({ allow: false, deny: true })
    expect(evaluatePublicServe({ node: undefined })).toEqual({ allow: false, deny: true })
  })

  it('denies a public node that exceeds the size ceiling', () => {
    expect(
      evaluatePublicServe({ node: fileNode({ size: PUBLIC_SERVE_MAX_BYTES + 1 }) }).allow,
    ).toBe(false)
  })

  it('allows a public node exactly at the size ceiling', () => {
    expect(evaluatePublicServe({ node: fileNode({ size: PUBLIC_SERVE_MAX_BYTES }) }).allow).toBe(
      true,
    )
  })

  it('denies a public file whose size is unknown', () => {
    expect(evaluatePublicServe({ node: fileNode({ size: null }) }).allow).toBe(false)
    expect(evaluatePublicServe({ node: fileNode({ size: undefined }) }).allow).toBe(false)
  })

  it('coerces a numeric-string size', () => {
    expect(evaluatePublicServe({ node: fileNode({ size: '2048' }) }).allow).toBe(true)
  })

  it('denies a public folder or site (only files are servable)', () => {
    expect(evaluatePublicServe({ node: fileNode({ nodeType: 'folder' }) }).allow).toBe(false)
    expect(evaluatePublicServe({ node: fileNode({ nodeType: 'site' }) }).allow).toBe(false)
  })

  it('respects an explicit maxBytes override', () => {
    expect(evaluatePublicServe({ node: fileNode({ size: 2048 }), maxBytes: 1024 }).allow).toBe(
      false,
    )
  })
})
