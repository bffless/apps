import { describe, it, expect } from 'vitest'
import type { Scene } from './scenes'
import {
  buildBlogRequest,
  toBlog,
  isBlogStale,
  parseFrameTokens,
  planBlogCaptures,
  rewriteFrameTokens,
  frameFileName,
  blogSlug,
} from './blog'

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

describe('parseFrameTokens', () => {
  it('reads caption + global timestamp from each token in document order', () => {
    const md = 'Intro.\n\n![The diff](frame:142.5)\n\nMiddle.\n\n![Result](frame:7)'
    expect(parseFrameTokens(md)).toEqual([
      { time: 142.5, caption: 'The diff', raw: '![The diff](frame:142.5)' },
      { time: 7, caption: 'Result', raw: '![Result](frame:7)' },
    ])
  })

  it('tolerates whitespace inside the token and an empty caption', () => {
    expect(parseFrameTokens('![]( frame: 12.0 )')).toEqual([
      { time: 12, caption: '', raw: '![]( frame: 12.0 )' },
    ])
  })

  it('skips malformed tokens (non-numeric or negative timestamps)', () => {
    expect(parseFrameTokens('![a](frame:abc) ![b](frame:) ![c](frame:-3)')).toEqual([])
  })

  it('ignores ordinary Markdown image links that are not frame tokens', () => {
    expect(parseFrameTokens('![logo](https://x/y.png) text')).toEqual([])
  })
})

describe('planBlogCaptures', () => {
  const sources = [
    { id: 'a', duration: 100 },
    { id: 'b', duration: 50 },
  ]

  it('dedups by timestamp and numbers the captures frame-01, frame-02, …', () => {
    const md = '![one](frame:10)\n![dup](frame:10)\n![two](frame:20)'
    expect(planBlogCaptures(md, sources)).toEqual([
      { time: 10, sourceId: 'a', localTime: 10, fileName: 'frame-01.jpg' },
      { time: 20, sourceId: 'a', localTime: 20, fileName: 'frame-02.jpg' },
    ])
  })

  it('maps a global timestamp in the second source to its correct (sourceId, localTime)', () => {
    // 120s is 20s into source b (which starts at 100s on the global timeline).
    expect(planBlogCaptures('![x](frame:120)', sources)).toEqual([
      { time: 120, sourceId: 'b', localTime: 20, fileName: 'frame-01.jpg' },
    ])
  })

  it('drops timestamps that cannot be routed to a source', () => {
    expect(planBlogCaptures('![x](frame:5)', [])).toEqual([])
  })
})

describe('rewriteFrameTokens', () => {
  it('rewrites each token to its uploaded serve URL, preserving the caption', () => {
    const md = 'A.\n\n![The diff](frame:142.5)\n\nB.'
    const urls = new Map([[142.5, '/api/uploads/blog/projects/p/blog/frame-01.jpg']])
    expect(rewriteFrameTokens(md, urls)).toBe(
      'A.\n\n![The diff](/api/uploads/blog/projects/p/blog/frame-01.jpg)\n\nB.',
    )
  })

  it('points every duplicate of a timestamp at the one uploaded frame', () => {
    const md = '![one](frame:10) ![again](frame:10)'
    const urls = new Map([[10, '/u/frame-01.jpg']])
    expect(rewriteFrameTokens(md, urls)).toBe('![one](/u/frame-01.jpg) ![again](/u/frame-01.jpg)')
  })

  it('drops a token whose frame never uploaded, never leaving a broken image', () => {
    const md = 'Before ![missing](frame:99) after'
    expect(rewriteFrameTokens(md, new Map())).toBe('Before  after')
    expect(rewriteFrameTokens(md, new Map())).not.toContain('frame:')
  })

  it('strips a malformed token outright', () => {
    expect(rewriteFrameTokens('x ![bad](frame:nope) y', new Map())).toBe('x  y')
  })
})

describe('frameFileName / blogSlug', () => {
  it('zero-pads the frame index', () => {
    expect(frameFileName(1)).toBe('frame-01.jpg')
    expect(frameFileName(12)).toBe('frame-12.jpg')
  })

  it('slugs a title and falls back to "post"', () => {
    expect(blogSlug('  Onboarding: Rules & More!  ')).toBe('onboarding-rules-more')
    expect(blogSlug('!!!')).toBe('post')
    expect(blogSlug('')).toBe('post')
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
