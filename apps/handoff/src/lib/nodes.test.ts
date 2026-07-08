/**
 * Unit tests for nodes.ts — exhaustive TDD-first coverage.
 * RED phase: written before the implementation exists.
 */

import { describe, it, expect } from 'vitest'
import { toNode, toNodeList, buildRegisterBody } from './nodes'

// ---------------------------------------------------------------------------
// toNode
// ---------------------------------------------------------------------------

describe('toNode — happy path', () => {
  it('passes through a fully-formed node', () => {
    const raw = {
      id: 'abc123',
      type: 'file',
      name: 'photo.jpg',
      mime: 'image/jpeg',
      size: 204800,
      url: '/api/uploads/content/photo.jpg',
      storageKey: 'handoff/photo.jpg',
      parentId: 'root',
      createdAt: 1700000000000,
    }
    const node = toNode(raw)
    expect(node.id).toBe('abc123')
    expect(node.type).toBe('file')
    expect(node.name).toBe('photo.jpg')
    expect(node.mime).toBe('image/jpeg')
    expect(node.size).toBe(204800)
    expect(node.url).toBe('/api/uploads/content/photo.jpg')
    expect(node.storageKey).toBe('handoff/photo.jpg')
    expect(node.parentId).toBe('root')
    expect(node.createdAt).toBe(1700000000000)
  })
})

describe('toNode — content path', () => {
  it('passes an explicit path through verbatim', () => {
    expect(toNode({ path: 'Design Docs/doc.md' }).path).toBe('Design Docs/doc.md')
  })

  it('derives path from the content url when not explicit', () => {
    expect(toNode({ url: '/api/uploads/content/Design Docs/doc.md' }).path).toBe(
      'Design Docs/doc.md',
    )
  })

  it('is null when there is no content url (e.g. presigned video)', () => {
    expect(toNode({ url: null }).path).toBeNull()
  })
})

describe('toNode — missing / undefined fields', () => {
  it('defaults id to empty string when absent', () => {
    expect(toNode({})).toMatchObject({ id: '' })
  })

  it('defaults type to "file" when absent', () => {
    expect(toNode({})).toMatchObject({ type: 'file' })
  })

  it('defaults name to "Untitled" when absent', () => {
    expect(toNode({})).toMatchObject({ name: 'Untitled' })
  })

  it('trims name and falls back to "Untitled" for whitespace-only', () => {
    expect(toNode({ name: '  ' })).toMatchObject({ name: 'Untitled' })
    expect(toNode({ name: '  hello  ' })).toMatchObject({ name: 'hello' })
  })

  it('defaults mime to null when absent', () => {
    expect(toNode({})).toMatchObject({ mime: null })
  })

  it('defaults size to null when absent', () => {
    expect(toNode({})).toMatchObject({ size: null })
  })

  it('defaults url to null when absent', () => {
    expect(toNode({})).toMatchObject({ url: null })
  })

  it('defaults storageKey to null when absent', () => {
    expect(toNode({})).toMatchObject({ storageKey: null })
  })

  it('defaults parentId to "root" when absent', () => {
    expect(toNode({})).toMatchObject({ parentId: 'root' })
  })

  it('defaults createdAt to 0 when absent', () => {
    expect(toNode({})).toMatchObject({ createdAt: 0 })
  })
})

describe('toNode — wrong types', () => {
  it('coerces non-string id to string', () => {
    expect(toNode({ id: 42 })).toMatchObject({ id: '42' })
  })

  it('falls back type to "file" for unknown string', () => {
    expect(toNode({ type: 'widget' })).toMatchObject({ type: 'file' })
  })

  it('accepts all known NodeTypes', () => {
    expect(toNode({ type: 'file' })).toMatchObject({ type: 'file' })
    expect(toNode({ type: 'folder' })).toMatchObject({ type: 'folder' })
    expect(toNode({ type: 'site' })).toMatchObject({ type: 'site' })
  })

  it('sets size to null when non-finite', () => {
    expect(toNode({ size: Infinity })).toMatchObject({ size: null })
    expect(toNode({ size: NaN })).toMatchObject({ size: null })
    expect(toNode({ size: 'big' })).toMatchObject({ size: null })
  })

  it('parses numeric-string size', () => {
    expect(toNode({ size: '1024' })).toMatchObject({ size: 1024 })
  })

  it('sets url to null when not a string', () => {
    expect(toNode({ url: 42 })).toMatchObject({ url: null })
  })

  it('sets storageKey to null when not a string', () => {
    expect(toNode({ storageKey: true })).toMatchObject({ storageKey: null })
  })

  it('falls back parentId to "root" for non-string', () => {
    expect(toNode({ parentId: 99 })).toMatchObject({ parentId: 'root' })
  })

  it('sets createdAt to 0 when non-finite', () => {
    expect(toNode({ createdAt: 'bad' })).toMatchObject({ createdAt: 0 })
    expect(toNode({ createdAt: NaN })).toMatchObject({ createdAt: 0 })
  })

  it('never throws on null input', () => {
    expect(() => toNode(null)).not.toThrow()
  })

  it('never throws on non-object primitive', () => {
    expect(() => toNode('string')).not.toThrow()
    expect(() => toNode(42)).not.toThrow()
    expect(() => toNode(undefined)).not.toThrow()
  })
})

describe('toNode — null url explicitly', () => {
  it('keeps explicit null url as null', () => {
    expect(toNode({ url: null })).toMatchObject({ url: null })
  })
})

describe('toNode title/description', () => {
  it('coerces title and description from strings', () => {
    const n = toNode({ id: 'x', type: 'file', title: 'My Deck', description: 'line1\nline2' })
    expect(n.title).toBe('My Deck')
    expect(n.description).toBe('line1\nline2')
  })

  it('defaults missing/blank title and missing description to null', () => {
    expect(toNode({ id: 'x' }).title).toBeNull()
    expect(toNode({ id: 'x' }).description).toBeNull()
    expect(toNode({ id: 'x', title: '   ' }).title).toBeNull()
  })

  it('ignores non-string title/description', () => {
    const n = toNode({ id: 'x', title: 42, description: { bad: true } })
    expect(n.title).toBeNull()
    expect(n.description).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// toNodeList
// ---------------------------------------------------------------------------

describe('toNodeList — object-wrapped', () => {
  it('extracts nodes from { nodes: [...] }', () => {
    const raw = {
      nodes: [
        { id: '1', name: 'a.txt', type: 'file' },
        { id: '2', name: 'b.txt', type: 'file' },
      ],
    }
    const list = toNodeList(raw)
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('1')
    expect(list[1].id).toBe('2')
  })
})

describe('toNodeList — bare array', () => {
  it('accepts a bare array', () => {
    const raw = [{ id: '1', name: 'a.txt' }, { id: '2' }]
    const list = toNodeList(raw)
    expect(list).toHaveLength(2)
  })
})

describe('toNodeList — drops garbage entries', () => {
  it('filters out non-objects in the nodes array', () => {
    const raw = { nodes: [{ id: '1' }, null, 'bad', 42, { id: '2' }] }
    const list = toNodeList(raw)
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('1')
    expect(list[1].id).toBe('2')
  })
})

describe('toNodeList — empty', () => {
  it('returns [] for empty nodes array', () => {
    expect(toNodeList({ nodes: [] })).toEqual([])
  })

  it('returns [] for garbage input', () => {
    expect(toNodeList(null)).toEqual([])
    expect(toNodeList('bad')).toEqual([])
    expect(toNodeList(42)).toEqual([])
    expect(toNodeList({})).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildRegisterBody
// ---------------------------------------------------------------------------

describe('buildRegisterBody', () => {
  const prepared = {
    storageKey: 'handoff/uploads/photo.jpg',
    uploadUrl: 'https://bucket.example.com/put/photo.jpg',
    publicPath: '/api/uploads/content/photo.jpg',
    storedFilename: 'photo-20231101.jpg',
    originalName: 'photo.jpg',
    expiresIn: 3600,
    expiresAt: 1700003600000,
    maxFileSize: 10485760,
    allowedMimeTypes: ['image/*'],
  }
  const file = new File(['data'], 'my photo.jpg', { type: 'image/jpeg' })
  const parentId = 'root'
  const nowMs = 1700000000000

  it('maps storageKey from prepared', () => {
    const body = buildRegisterBody(prepared, file, parentId, nowMs)
    expect(body.storageKey).toBe('handoff/uploads/photo.jpg')
  })

  it('uses file.name as originalName', () => {
    const body = buildRegisterBody(prepared, file, parentId, nowMs)
    expect(body.originalName).toBe('my photo.jpg')
  })

  it('carries parentId', () => {
    const body = buildRegisterBody(prepared, file, parentId, nowMs)
    expect(body.parentId).toBe('root')
  })

  it('uses file.name as displayName', () => {
    const body = buildRegisterBody(prepared, file, parentId, nowMs)
    expect(body.displayName).toBe('my photo.jpg')
  })

  it('carries nowMs as createdMs', () => {
    const body = buildRegisterBody(prepared, file, parentId, nowMs)
    expect(body.createdMs).toBe(1700000000000)
  })

  it('works with a different parentId', () => {
    const body = buildRegisterBody(prepared, file, 'folder-42', nowMs)
    expect(body.parentId).toBe('folder-42')
  })

  it('records the verbatim content path (publicPath minus the serve prefix)', () => {
    const nested = { ...prepared, publicPath: '/api/uploads/content/Design Docs/doc.md' }
    const body = buildRegisterBody(nested, file, parentId, nowMs)
    expect(body.path).toBe('Design Docs/doc.md')
  })
})
