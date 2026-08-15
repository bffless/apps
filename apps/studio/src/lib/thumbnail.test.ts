import { describe, it, expect } from 'vitest'
import type { Scene } from './scenes'
import {
  buildThumbnailDraftRequest,
  toThumbnailPrompt,
  toThumbnailImage,
  thumbnailFileName,
  referenceFileError,
  MAX_REFERENCE_BYTES,
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
      hasReference: false,
    })
  })

  it('produces an empty script when a scene has no words at all', () => {
    const req = buildThumbnailDraftRequest([scene({ transcript: '' })], 'T', 'D', '', () => [])
    expect(req.script).toBe('')
  })

  // The drafting handler branches on this: with a reference attached it writes
  // the photo into the prompt and drops the "photorealistic humans" negative.
  it('carries the reference flag so the drafter writes the attached photo in', () => {
    const req = buildThumbnailDraftRequest([scene()], 'T', 'D', '', wordsFor, true)
    expect(req.hasReference).toBe(true)
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
  it('snake_cases the title and appends .jpg', () => {
    expect(thumbnailFileName('Overview of Onboarding Rules')).toBe('overview_of_onboarding_rules.jpg')
  })
  it('collapses punctuation/whitespace runs and trims edges', () => {
    expect(thumbnailFileName('  My Great Video!! (2026) ')).toBe('my_great_video_2026.jpg')
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

describe('referenceFileError', () => {
  it('accepts a normal image', () => {
    expect(referenceFileError({ type: 'image/png', size: 500_000 })).toBeNull()
  })

  it('rejects a non-image, so a picked video never starts an upload', () => {
    expect(referenceFileError({ type: 'video/mp4', size: 10 })).toMatch(/image/i)
  })

  it('rejects an image over the 10 MB rule cap, naming the actual size', () => {
    const msg = referenceFileError({ type: 'image/jpeg', size: MAX_REFERENCE_BYTES + 1 })
    expect(msg).toMatch(/10 MB/)
  })

  it('accepts an image exactly at the cap', () => {
    expect(referenceFileError({ type: 'image/jpeg', size: MAX_REFERENCE_BYTES })).toBeNull()
  })
})
