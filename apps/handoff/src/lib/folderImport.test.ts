/**
 * Unit tests for folderImport.ts — TDD-first coverage for planFolderImport.
 * Written BEFORE the implementation (RED phase).
 *
 * planFolderImport reuses planSiteUpload's normalisation (strip `./`, drop
 * junk, strip a single common top dir) so Site and tree planning agree on
 * paths, then derives the folder tree to recreate.
 */

import { describe, it, expect } from 'vitest'
import { planFolderImport } from './folderImport'

describe('planFolderImport — flat folder (no sub-dirs)', () => {
  it('produces no dirs and one file entry per file, all in the root dir', () => {
    const plan = planFolderImport([
      { relPath: 'a.md' },
      { relPath: 'b.pdf' },
    ])
    expect(plan.dirs).toEqual([])
    expect(plan.files).toEqual([
      { relPath: 'a.md', dir: '', name: 'a.md' },
      { relPath: 'b.pdf', dir: '', name: 'b.pdf' },
    ])
  })
})

describe('planFolderImport — nested structure', () => {
  it('derives every ancestor dir for a deeply nested file', () => {
    // No shared single top dir (two distinct tops) → nothing stripped.
    const plan = planFolderImport([
      { relPath: 'a/b/c.md' },
      { relPath: 'x.md' },
    ])
    expect(plan.dirs).toEqual(['a', 'a/b'])
    expect(plan.files).toContainEqual({ relPath: 'a/b/c.md', dir: 'a/b', name: 'c.md' })
    expect(plan.files).toContainEqual({ relPath: 'x.md', dir: '', name: 'x.md' })
  })
})

describe('planFolderImport — multiple files per dir', () => {
  it('lists a dir once even when several files share it', () => {
    const plan = planFolderImport([
      { relPath: 'docs/one.md' },
      { relPath: 'docs/two.md' },
      { relPath: 'docs/three.md' },
      { relPath: 'top.md' },
    ])
    expect(plan.dirs).toEqual(['docs'])
    expect(plan.files.filter((f) => f.dir === 'docs')).toHaveLength(3)
  })
})

describe('planFolderImport — parent-before-child ordering', () => {
  it('always lists a parent dir before any of its children', () => {
    // `root.md` at top level means there is no single common top dir to strip.
    const plan = planFolderImport([
      { relPath: 'a/b/c/deep.md' },
      { relPath: 'a/sibling.md' },
      { relPath: 'a/b/mid.md' },
      { relPath: 'root.md' },
    ])
    // Every dir must appear after its parent.
    for (let i = 0; i < plan.dirs.length; i++) {
      const dir = plan.dirs[i]!
      const slash = dir.lastIndexOf('/')
      if (slash === -1) continue
      const parent = dir.slice(0, slash)
      expect(plan.dirs.indexOf(parent)).toBeLessThan(i)
    }
    expect(plan.dirs).toEqual(['a', 'a/b', 'a/b/c'])
  })
})

describe('planFolderImport — html detection', () => {
  it('sets hasHtml + rootIndexHtml for a root index.html', () => {
    const plan = planFolderImport([
      { relPath: 'index.html' },
      { relPath: 'style.css' },
    ])
    expect(plan.hasHtml).toBe(true)
    expect(plan.rootIndexHtml).toBe(true)
  })

  it('sets hasHtml but NOT rootIndexHtml for a nested-only html', () => {
    const plan = planFolderImport([
      { relPath: 'pages/about.html' },
      { relPath: 'pages/main.htm' },
    ])
    expect(plan.hasHtml).toBe(true)
    expect(plan.rootIndexHtml).toBe(false)
  })

  it('detects .htm as html too', () => {
    const plan = planFolderImport([{ relPath: 'page.htm' }])
    expect(plan.hasHtml).toBe(true)
    expect(plan.rootIndexHtml).toBe(false)
  })

  it('no html → both flags false', () => {
    const plan = planFolderImport([
      { relPath: 'a.md' },
      { relPath: 'img/pic.png' },
    ])
    expect(plan.hasHtml).toBe(false)
    expect(plan.rootIndexHtml).toBe(false)
  })
})

describe('planFolderImport — common top-dir strip (folder-drop wrapping)', () => {
  it('strips a single shared top dir so contents land at the root', () => {
    const plan = planFolderImport([
      { relPath: 'mynotes/index.html' },
      { relPath: 'mynotes/sub/a.md' },
      { relPath: 'mynotes/sub/b.md' },
    ])
    // 'mynotes/' stripped → root index.html present, only 'sub' nested.
    expect(plan.rootIndexHtml).toBe(true)
    expect(plan.dirs).toEqual(['sub'])
    expect(plan.files).toContainEqual({ relPath: 'index.html', dir: '', name: 'index.html' })
    expect(plan.files).toContainEqual({ relPath: 'sub/a.md', dir: 'sub', name: 'a.md' })
  })
})

describe('planFolderImport — normalisation parity with planSiteUpload', () => {
  it('strips leading ./ and drops junk entries', () => {
    const plan = planFolderImport([
      { relPath: './a.md' },
      { relPath: '' },
      { relPath: '.' },
      { relPath: './docs/b.md' },
    ])
    expect(plan.files).toContainEqual({ relPath: 'a.md', dir: '', name: 'a.md' })
    expect(plan.files).toContainEqual({ relPath: 'docs/b.md', dir: 'docs', name: 'b.md' })
    expect(plan.files.map((f) => f.relPath)).not.toContain('')
    expect(plan.files).toHaveLength(2)
  })
})

describe('planFolderImport — empty input', () => {
  it('returns empty dirs/files and false flags', () => {
    const plan = planFolderImport([])
    expect(plan.dirs).toEqual([])
    expect(plan.files).toEqual([])
    expect(plan.hasHtml).toBe(false)
    expect(plan.rootIndexHtml).toBe(false)
  })
})
