import { describe, it, expect } from 'vitest'
import { isNameTaken, nameCollisionMessage } from './nameCollision'
import type { SiblingRef } from './nameCollision'

const siblings: SiblingRef[] = [
  { name: 'README.md', parentId: 'folder-a' },
  { name: 'assets', parentId: 'folder-a' }, // a sub-folder — still a sibling name
  { name: 'notes.md', parentId: 'folder-b' },
]

describe('isNameTaken — the in-Folder uniqueness decision', () => {
  it('accepts a unique name in the folder', () => {
    expect(isNameTaken(siblings, 'folder-a', 'CHANGELOG.md')).toBe(false)
  })

  it('rejects a name that duplicates an existing sibling in the same folder', () => {
    expect(isNameTaken(siblings, 'folder-a', 'README.md')).toBe(true)
  })

  it('collides with a sibling of any type (a File name vs an existing Folder name)', () => {
    expect(isNameTaken(siblings, 'folder-a', 'assets')).toBe(true)
  })

  it('allows the same name in a different folder', () => {
    // 'README.md' exists in folder-a but folder-b is a different sibling set.
    expect(isNameTaken(siblings, 'folder-b', 'README.md')).toBe(false)
  })

  it('is case- and unicode-sensitive (verbatim keys are distinct)', () => {
    expect(isNameTaken(siblings, 'folder-a', 'readme.md')).toBe(false)
    expect(isNameTaken(siblings, 'folder-a', 'README.MD')).toBe(false)
  })

  it('treats an empty folder as always unique', () => {
    expect(isNameTaken([], 'folder-a', 'README.md')).toBe(false)
  })
})

describe('nameCollisionMessage', () => {
  it('names the offending file in a clear, actionable message', () => {
    const msg = nameCollisionMessage('logo.png')
    expect(msg).toContain('logo.png')
    expect(msg.toLowerCase()).toContain('already exists')
  })
})
