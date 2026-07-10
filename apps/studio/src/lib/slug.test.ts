import { describe, expect, it } from 'vitest'
import { finalCutFileName, slugify, thumbnailFileName } from './slug'

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Overview of Onboarding Rules')).toBe('overview-of-onboarding-rules')
  })

  it('collapses runs of non-alphanumerics and trims the ends', () => {
    expect(slugify('  My Great Video!! (2026) ')).toBe('my-great-video-2026')
  })

  it('returns an empty string when nothing survives', () => {
    expect(slugify('')).toBe('')
    expect(slugify('—!!—')).toBe('')
  })
})

describe('thumbnailFileName', () => {
  it('slugs the title with a .jpg extension', () => {
    expect(thumbnailFileName('Overview of Onboarding Rules')).toBe(
      'overview-of-onboarding-rules.jpg',
    )
  })

  it('falls back to thumbnail.jpg', () => {
    expect(thumbnailFileName('')).toBe('thumbnail.jpg')
    expect(thumbnailFileName('—!!—')).toBe('thumbnail.jpg')
  })
})

describe('finalCutFileName', () => {
  it('slugs the title with a .mp4 extension', () => {
    expect(finalCutFileName('Custom AI Content Pipeline')).toBe(
      'custom-ai-content-pipeline.mp4',
    )
  })

  it('falls back to studio-final-cut.mp4', () => {
    expect(finalCutFileName('')).toBe('studio-final-cut.mp4')
    expect(finalCutFileName('—!!—')).toBe('studio-final-cut.mp4')
  })
})
