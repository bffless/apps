import { describe, it, expect } from 'vitest'
import type { Scene } from './scenes'
import { buildBlogRequest, toBlog, isBlogStale } from './blog'

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
    narrationSeconds: null,
    ...over,
  }
}

const refined = (segments: { text: string; start: number; end: number }[]) => ({
  refined: { segments, cuts: [], source: 'ai' as const },
})

describe('buildBlogRequest', () => {
  it('shapes the final kept script + trimmed direction with empty context', () => {
    const scenes = [
      scene({ id: 'a', title: 'Intro', transcript: 'raw intro', ...refined([{ text: 'Hello there.', start: 0, end: 2 }]) }),
      scene({ id: 'b', title: 'Body', transcript: 'raw body', ...refined([{ text: 'Second scene.', start: 0, end: 2 }]) }),
    ]
    expect(buildBlogRequest(scenes, '  keep it punchy  ')).toEqual({
      script: 'Hello there.\n\nSecond scene.',
      direction: 'keep it punchy',
      title: '',
      summary: '',
      synopsis: '',
      scenes: [
        { title: 'Intro', transcript: 'raw intro' },
        { title: 'Body', transcript: 'raw body' },
      ],
      sheetUrls: [],
      duration: 0,
    })
  })

  it('folds in title, summary, synopsis, signed sheet URLs and duration', () => {
    const scenes = [scene({ id: 'a', title: 'Intro', transcript: 'raw intro', ...refined([{ text: 'Hi.', start: 0, end: 1 }]) })]
    expect(
      buildBlogRequest(scenes, 'friendly', {
        synopsis: '  a punchy logline  ',
        description: { title: '  The Title  ', summary: '  The summary.  ' },
        sheetUrls: ['/api/uploads/projects/p/thumbnails/a.jpg', null, '', undefined],
        duration: 123.4,
      }),
    ).toEqual({
      script: 'Hi.',
      direction: 'friendly',
      title: 'The Title',
      summary: 'The summary.',
      synopsis: 'a punchy logline',
      scenes: [{ title: 'Intro', transcript: 'raw intro' }],
      sheetUrls: ['/api/uploads/projects/p/thumbnails/a.jpg'],
      duration: 123.4,
    })
  })

  it('tolerates an empty direction and no scenes', () => {
    expect(buildBlogRequest([], '')).toEqual({
      script: '',
      direction: '',
      title: '',
      summary: '',
      synopsis: '',
      scenes: [],
      sheetUrls: [],
      duration: 0,
    })
  })
})

describe('isBlogStale', () => {
  const post = (over: Partial<{ markdown: string; script: string; status: string }> = {}) => ({
    markdown: '# Post',
    script: 'Hello there.',
    status: 'done',
    ...over,
  })

  it('is stale when a generated post no longer matches the current final script', () => {
    expect(isBlogStale(post({ script: 'Old script.' }), 'New script.')).toBe(true)
  })

  it('is not stale when the current final script still matches', () => {
    expect(isBlogStale(post({ script: 'Hello there.' }), 'Hello there.')).toBe(false)
  })

  it('ignores surrounding whitespace on both sides', () => {
    expect(isBlogStale(post({ script: 'Hello there.' }), '  Hello there.  ')).toBe(false)
  })

  it('is never stale for a post that has not finished generating', () => {
    expect(isBlogStale(post({ status: 'running', script: 'a' }), 'b')).toBe(false)
    expect(isBlogStale(post({ status: 'idle', script: 'a' }), 'b')).toBe(false)
    expect(isBlogStale(post({ status: 'error', script: 'a' }), 'b')).toBe(false)
  })

  it('is never stale when there is no post or no markdown yet', () => {
    expect(isBlogStale(null, 'anything')).toBe(false)
    expect(isBlogStale(post({ markdown: '', script: 'a' }), 'b')).toBe(false)
  })
})

describe('toBlog', () => {
  it('reads markdown off the object envelope and trims it', () => {
    expect(toBlog({ markdown: '# Title\n\nBody.\n\n' })).toEqual({ markdown: '# Title\n\nBody.' })
  })

  it('accepts a bare markdown string', () => {
    expect(toBlog('## Heading')).toEqual({ markdown: '## Heading' })
  })

  it('falls back to empty markdown for garbage', () => {
    expect(toBlog(null)).toEqual({ markdown: '' })
    expect(toBlog(42)).toEqual({ markdown: '' })
    expect(toBlog({ markdown: 99 })).toEqual({ markdown: '' })
    expect(toBlog({})).toEqual({ markdown: '' })
  })
})
