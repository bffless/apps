import { describe, it, expect } from 'vitest'
import type { Scene } from './scenes'
import { buildBlogRequest, toBlog } from './blog'

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
