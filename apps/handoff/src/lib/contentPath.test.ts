import { describe, it, expect } from 'vitest'
import {
  contentSubPath,
  viewerBase,
  UnsafeContentPathError,
  MAX_KEY_BYTES,
} from './contentPath'

// ---------------------------------------------------------------------------
// Seam A — contentSubPath (verbatim structural key)
// ---------------------------------------------------------------------------

describe('contentSubPath — verbatim structure', () => {
  it('joins a root upload (empty folder path) to the bare name', () => {
    expect(contentSubPath('', 'doc.md')).toBe('doc.md')
  })

  it('joins the owning folder path and the file name', () => {
    expect(contentSubPath('Design Docs/Q3 Handoff', 'doc.md')).toBe(
      'Design Docs/Q3 Handoff/doc.md',
    )
  })

  it('preserves spaces verbatim (no sanitisation)', () => {
    expect(contentSubPath('Design Docs', 'my file.md')).toBe('Design Docs/my file.md')
  })

  it('preserves unicode verbatim', () => {
    expect(contentSubPath('设计文档', 'café ☕.md')).toBe('设计文档/café ☕.md')
  })

  it('preserves a nested relative path (subtree import case)', () => {
    expect(contentSubPath('Design Docs', 'assets/logo.png')).toBe(
      'Design Docs/assets/logo.png',
    )
  })

  it('tolerates leading/trailing slashes on the folder path', () => {
    expect(contentSubPath('/Design Docs/', 'doc.md')).toBe('Design Docs/doc.md')
  })
})

describe('contentSubPath — rejects unsafe input', () => {
  it('rejects a `..` segment (path traversal)', () => {
    expect(() => contentSubPath('Design Docs', '../secret.md')).toThrow(UnsafeContentPathError)
  })

  it('rejects a `..` segment anywhere in the relative path', () => {
    expect(() => contentSubPath('Design Docs', 'assets/../../etc/passwd')).toThrow(
      UnsafeContentPathError,
    )
  })

  it('rejects a `.` segment', () => {
    expect(() => contentSubPath('Design Docs', './doc.md')).toThrow(UnsafeContentPathError)
  })

  it('rejects an empty relative path', () => {
    expect(() => contentSubPath('Design Docs', '')).toThrow(UnsafeContentPathError)
  })

  it('rejects an empty interior segment (`//`)', () => {
    expect(() => contentSubPath('Design Docs', 'assets//logo.png')).toThrow(
      UnsafeContentPathError,
    )
  })

  it('rejects a control character in a name', () => {
    expect(() => contentSubPath('Design Docs', `do${String.fromCharCode(0)}c.md`)).toThrow(
      UnsafeContentPathError,
    )
  })

  it('rejects a key over the byte limit', () => {
    const huge = 'a'.repeat(MAX_KEY_BYTES + 1)
    expect(() => contentSubPath('', huge)).toThrow(UnsafeContentPathError)
  })

  it('accepts a key exactly at the byte limit', () => {
    const exact = 'a'.repeat(MAX_KEY_BYTES)
    expect(contentSubPath('', exact)).toBe(exact)
  })
})

// ---------------------------------------------------------------------------
// Seam B — viewerBase (relative-resolution base for the viewer)
// ---------------------------------------------------------------------------

describe('viewerBase', () => {
  it("returns the file's folder so a relative asset resolves under it", () => {
    const base = viewerBase({ url: '/api/uploads/content/Design Docs/doc.md' })
    expect(base).toBe('/api/uploads/content/Design Docs/')
    // A relative reference resolves to the real sibling content URL. The browser
    // percent-encodes the space at the HTTP layer (the server decodes it back).
    expect(new URL('assets/logo.png', `https://x${base}`).pathname).toBe(
      '/api/uploads/content/Design%20Docs/assets/logo.png',
    )
  })

  it('handles a root-level file (no folder)', () => {
    expect(viewerBase({ url: '/api/uploads/content/doc.md' })).toBe('/api/uploads/content/')
  })

  it('returns null when the node has no content URL (e.g. presigned video)', () => {
    expect(viewerBase({ url: null })).toBeNull()
  })
})
