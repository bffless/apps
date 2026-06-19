import { describe, it, expect } from 'vitest'
import { phaseOf, deriveProjectMeta, nextUntitledName, DEFAULT_PROJECT_NAME } from './projects'
import { freshWorkingState } from '../store/studioSlice'

describe('phaseOf', () => {
  it('is import when there are no sources', () => {
    expect(phaseOf(freshWorkingState())).toBe('import')
  })
  it('is prep when a source exists but no scenes', () => {
    const w = freshWorkingState()
    w.sources = [{ id: 's1', order: 0, fileName: 'a.mp4', duration: 10, sourceUrl: 'u', audioUrl: null, audioPeaks: [], words: [], transcribeJobId: null, stageProgress: {} }]
    expect(phaseOf(w)).toBe('prep')
  })
  it('is export when every scene is built', () => {
    const w = freshWorkingState()
    w.sources = [{ id: 's1', order: 0, fileName: 'a.mp4', duration: 10, sourceUrl: 'u', audioUrl: null, audioPeaks: [], words: [], transcribeJobId: null, stageProgress: { upload: { status: 'done' }, extract: { status: 'done' }, transcribe: { status: 'done' } } }]
    for (const id of ['thumbnails', 'clone', 'director'] as const) w.stageProgress[id] = { status: 'done' }
    w.scenes = [{ id: 'sc1', status: 'built' } as never]
    expect(phaseOf(w)).toBe('export')
  })
})

describe('deriveProjectMeta', () => {
  it('reads the first persisted contact-sheet url as the thumbnail', () => {
    const w = freshWorkingState()
    w.contactSheets = [{ url: undefined } as never, { url: '/api/uploads/thumbnails/x.png' } as never]
    expect(deriveProjectMeta(w).thumbnailUrl).toBe('/api/uploads/thumbnails/x.png')
  })
  it('returns a null thumbnail when no sheet has a persisted url', () => {
    expect(deriveProjectMeta(freshWorkingState()).thumbnailUrl).toBeNull()
  })
  it('prefers the generated YouTube thumbnail over the contact sheet', () => {
    const w = freshWorkingState()
    w.contactSheets = [{ url: '/api/uploads/thumbnails/x.png' } as never]
    w.youtubeThumbnail = { notes: 'bold', prompt: 'a 16:9 thumbnail', url: '/api/uploads/youtube-thumbnail/y.jpg' }
    expect(deriveProjectMeta(w).thumbnailUrl).toBe('/api/uploads/youtube-thumbnail/y.jpg')
  })
})

describe('nextUntitledName', () => {
  it('returns the default when none exist', () => {
    expect(nextUntitledName([])).toBe(DEFAULT_PROJECT_NAME)
  })
  it('numbers the next one when the default name is taken', () => {
    expect(nextUntitledName([DEFAULT_PROJECT_NAME])).toBe(`${DEFAULT_PROJECT_NAME} 2`)
    expect(nextUntitledName([DEFAULT_PROJECT_NAME, `${DEFAULT_PROJECT_NAME} 2`])).toBe(`${DEFAULT_PROJECT_NAME} 3`)
  })
})
