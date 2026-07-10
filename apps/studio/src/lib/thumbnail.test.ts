import { describe, it, expect } from 'vitest'
import type { Scene } from './scenes'
import {
  buildThumbnailDraftRequest,
  toThumbnailPrompt,
  toThumbnailImage,
  thumbnailFileName,
} from './thumbnail'

function scene(over: Partial<Scene> = {}): Scene {
  return {
    id: 's1',
    index: 0,
    sourceId: 'source-1',
    title: 'Scene 1',
    start: 0,
    end: 60,
    transcript: 'original transcript words',
    status: 'built',
    ...over,
  }
}

/** A wordsFor handing each scene timed words for "Hello there." */
const wordsFor = () => [
  { text: 'Hello', start: 0, end: 0.5 },
  { text: 'there.', start: 1, end: 1.5 },
]

describe('buildThumbnailDraftRequest', () => {
  it('assembles title/description/script/notes, trimming and using the final script', () => {
    const req = buildThumbnailDraftRequest(
      [scene()],
      '  My Great Video  ',
      '  A summary.\n\n0:00 Scene 1  ',
      '  bold, dark navy  ',
      wordsFor,
    )
    expect(req).toEqual({
      title: 'My Great Video',
      description: 'A summary.\n\n0:00 Scene 1',
      script: 'Hello there.',
      notes: 'bold, dark navy',
    })
  })

  it('produces an empty script when a scene has no words at all', () => {
    const req = buildThumbnailDraftRequest([scene({ transcript: '' })], 'T', 'D', '', () => [])
    expect(req.script).toBe('')
  })
})

describe('toThumbnailPrompt', () => {
  it('extracts and trims the prompt string', () => {
    expect(toThumbnailPrompt({ prompt: '  a 16:9 thumbnail  ' })).toEqual({ prompt: 'a 16:9 thumbnail' })
  })
  it('falls back to empty string on a malformed reply', () => {
    expect(toThumbnailPrompt(null)).toEqual({ prompt: '' })
    expect(toThumbnailPrompt({ nope: 1 })).toEqual({ prompt: '' })
  })
})

describe('thumbnailFileName', () => {
  it('hyphenates the title and appends .jpg', () => {
    expect(thumbnailFileName('Overview of Onboarding Rules')).toBe('overview-of-onboarding-rules.jpg')
  })
  it('collapses punctuation/whitespace runs and trims edges', () => {
    expect(thumbnailFileName('  My Great Video!! (2026) ')).toBe('my-great-video-2026.jpg')
  })
  it('falls back to "thumbnail" for an empty or punctuation-only title', () => {
    expect(thumbnailFileName('')).toBe('thumbnail.jpg')
    expect(thumbnailFileName('—!!—')).toBe('thumbnail.jpg')
  })
})

describe('toThumbnailImage', () => {
  it('extracts imageUrl from { imageUrl }', () => {
    expect(toThumbnailImage({ imageUrl: '/api/uploads/youtube-thumbnail/x.png' }))
      .toEqual({ imageUrl: '/api/uploads/youtube-thumbnail/x.png' })
  })
  it('falls back to empty string on a malformed reply', () => {
    expect(toThumbnailImage(undefined)).toEqual({ imageUrl: '' })
  })
})
