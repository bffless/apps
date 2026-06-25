/**
 * Unit tests for site.ts — TDD-first coverage for planSiteUpload.
 * Written BEFORE the implementation (RED phase).
 */

import { describe, it, expect } from 'vitest'
import { planSiteUpload } from './site'

// ---------------------------------------------------------------------------
// planSiteUpload
// ---------------------------------------------------------------------------

describe('planSiteUpload — root index.html', () => {
  it('detects index.html at root as entry, no candidates', () => {
    const inputs = [
      { relPath: 'index.html' },
      { relPath: 'style.css' },
      { relPath: 'app.js' },
    ]
    const plan = planSiteUpload(inputs)
    expect(plan.entry).toBe('index.html')
    expect(plan.candidates).toEqual([])
    expect(plan.files.map((f) => f.relPath)).toContain('index.html')
  })
})

describe('planSiteUpload — single nested html', () => {
  it('single non-root html file becomes the entry (no shared top dir)', () => {
    // Mixed top dirs → no stripping; single html → it becomes entry
    const inputs = [
      { relPath: 'app/main.html' },
      { relPath: 'public/style.css' },
    ]
    const plan = planSiteUpload(inputs)
    expect(plan.entry).toBe('app/main.html')
    expect(plan.candidates).toEqual([])
  })

  it('single html after dir-stripping becomes the entry', () => {
    // All under 'app/' → strip to get main.html
    const inputs = [
      { relPath: 'app/main.html' },
      { relPath: 'app/style.css' },
    ]
    const plan = planSiteUpload(inputs)
    expect(plan.entry).toBe('main.html')
    expect(plan.candidates).toEqual([])
  })
})

describe('planSiteUpload — multiple html files', () => {
  it('entry is null, candidates lists all html files', () => {
    const inputs = [
      { relPath: 'index.htm' },
      { relPath: 'about.html' },
      { relPath: 'style.css' },
    ]
    const plan = planSiteUpload(inputs)
    expect(plan.entry).toBeNull()
    expect(plan.candidates).toHaveLength(2)
    expect(plan.candidates).toContain('index.htm')
    expect(plan.candidates).toContain('about.html')
  })
})

describe('planSiteUpload — no html files', () => {
  it('entry is null, candidates is empty', () => {
    const inputs = [
      { relPath: 'style.css' },
      { relPath: 'app.js' },
    ]
    const plan = planSiteUpload(inputs)
    expect(plan.entry).toBeNull()
    expect(plan.candidates).toEqual([])
  })
})

describe('planSiteUpload — common top-dir stripping', () => {
  it('strips a single shared top-level directory from all paths', () => {
    const inputs = [
      { relPath: 'bundle/index.html' },
      { relPath: 'bundle/style.css' },
      { relPath: 'bundle/app.js' },
    ]
    const plan = planSiteUpload(inputs)
    // After stripping 'bundle/', paths become index.html, style.css, app.js
    expect(plan.files.map((f) => f.relPath)).toContain('index.html')
    expect(plan.files.map((f) => f.relPath)).not.toContain('bundle/index.html')
    expect(plan.entry).toBe('index.html')
  })

  it('strips deeper nested top-level directory', () => {
    const inputs = [
      { relPath: 'mysite/index.html' },
      { relPath: 'mysite/assets/style.css' },
    ]
    const plan = planSiteUpload(inputs)
    expect(plan.files.map((f) => f.relPath)).toContain('index.html')
    expect(plan.files.map((f) => f.relPath)).toContain('assets/style.css')
    expect(plan.entry).toBe('index.html')
  })
})

describe('planSiteUpload — mixed paths (no shared top dir)', () => {
  it('leaves paths intact when no common top directory', () => {
    const inputs = [
      { relPath: 'src/index.html' },
      { relPath: 'public/style.css' },
    ]
    const plan = planSiteUpload(inputs)
    expect(plan.files.map((f) => f.relPath)).toContain('src/index.html')
    expect(plan.files.map((f) => f.relPath)).toContain('public/style.css')
  })
})

describe('planSiteUpload — ./ prefix stripping', () => {
  it('strips leading ./ from paths', () => {
    const inputs = [
      { relPath: './index.html' },
      { relPath: './style.css' },
    ]
    const plan = planSiteUpload(inputs)
    expect(plan.files.map((f) => f.relPath)).toContain('index.html')
    expect(plan.files.map((f) => f.relPath)).toContain('style.css')
    expect(plan.entry).toBe('index.html')
  })
})

describe('planSiteUpload — empty input', () => {
  it('returns empty files, null entry, empty candidates', () => {
    const plan = planSiteUpload([])
    expect(plan.files).toEqual([])
    expect(plan.entry).toBeNull()
    expect(plan.candidates).toEqual([])
  })
})

describe('planSiteUpload — empty/dot paths are dropped', () => {
  it('drops empty and . paths', () => {
    const inputs = [
      { relPath: '' },
      { relPath: '.' },
      { relPath: 'index.html' },
    ]
    const plan = planSiteUpload(inputs)
    expect(plan.files.map((f) => f.relPath)).not.toContain('')
    expect(plan.files.map((f) => f.relPath)).not.toContain('.')
    expect(plan.files.map((f) => f.relPath)).toContain('index.html')
    expect(plan.entry).toBe('index.html')
  })
})
