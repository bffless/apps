import { describe, it, test, expect } from 'vitest'
import { STAGE_DEFS, studioPhase, PER_VIDEO_STAGES, GLOBAL_STAGES } from './pipeline'

describe('STAGE_DEFS', () => {
  it('runs the prep steps in order and tags where each runs', () => {
    expect(STAGE_DEFS.map((s) => s.id)).toEqual([
      'upload',
      'extract',
      'transcribe',
      'thumbnails',
      'clone',
      'director',
    ])
    for (const s of STAGE_DEFS) {
      expect(['browser', 'pipeline', 'browser+pipeline']).toContain(s.where)
    }
  })

  it('gives each prep step its own action label', () => {
    const labelled = STAGE_DEFS.filter((s) => s.actionLabel).map((s) => s.id)
    // Every step is now a single deliberate action: upload, extract+audio,
    // transcribe, thumbnails, clone (voice), then the merged AI director
    // (shorten + segment in one Gemini call).
    expect(labelled).toEqual([
      'upload',
      'extract',
      'transcribe',
      'thumbnails',
      'clone',
      'director',
    ])
  })
})

describe('studioPhase', () => {
  it('walks import → prep → build → export from state', () => {
    expect(studioPhase({ hasSource: false, ready: false, allBuilt: false })).toBe('import')
    expect(studioPhase({ hasSource: true, ready: false, allBuilt: false })).toBe('prep')
    expect(studioPhase({ hasSource: true, ready: true, allBuilt: false })).toBe('build')
    expect(studioPhase({ hasSource: true, ready: true, allBuilt: true })).toBe('export')
  })
})

describe('stage scopes', () => {
  it('tags upload/extract/transcribe as per-video and the rest as global', () => {
    expect(PER_VIDEO_STAGES).toEqual(['upload', 'extract', 'transcribe'])
    expect(GLOBAL_STAGES).toEqual(['thumbnails', 'clone', 'director'])
  })
  it('every STAGE_DEF carries a scope', () => {
    expect(STAGE_DEFS.every((s) => s.scope === 'video' || s.scope === 'global')).toBe(true)
  })
})

test('voice (clone) comes before the director in the global plan', () => {
  expect(GLOBAL_STAGES).toEqual(['thumbnails', 'clone', 'director'])
  const ids = STAGE_DEFS.map((s) => s.id)
  expect(ids.indexOf('clone')).toBeLessThan(ids.indexOf('director'))
})
