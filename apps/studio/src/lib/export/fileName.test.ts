/**
 * Unit tests for the final cut's download filename (issue: the Download MP4 link
 * always saved as `studio-final-cut.mp4`, whatever the video was called).
 *
 * The name follows the same kebab-case slug rule the Blog bundle names its zip
 * with (`blogSlug`), so a video and its post land as matching siblings on disk.
 */

import { describe, it, expect } from 'vitest'
import { finalCutFileName } from './fileName'

describe('finalCutFileName', () => {
  it('kebab-cases the video title', () => {
    expect(finalCutFileName('Overview of Onboarding Rules')).toBe(
      'overview-of-onboarding-rules.mp4',
    )
  })

  it('collapses any run of non-alphanumerics to a single hyphen', () => {
    expect(finalCutFileName('Ship it — fast!  (v2)')).toBe('ship-it-fast-v2.mp4')
  })

  it('trims leading and trailing hyphens', () => {
    expect(finalCutFileName('  ...Hello World!!  ')).toBe('hello-world.mp4')
  })

  it('falls back to final-cut for an empty title', () => {
    expect(finalCutFileName('')).toBe('final-cut.mp4')
  })

  it('falls back to final-cut for a punctuation-only title', () => {
    expect(finalCutFileName('—!?')).toBe('final-cut.mp4')
  })
})
