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
  it('shapes the final kept script + trimmed direction', () => {
    const scenes = [
      scene({ id: 'a', ...refined([{ text: 'Hello there.', start: 0, end: 2 }]) }),
      scene({ id: 'b', ...refined([{ text: 'Second scene.', start: 0, end: 2 }]) }),
    ]
    expect(buildBlogRequest(scenes, '  keep it punchy  ')).toEqual({
      script: 'Hello there.\n\nSecond scene.',
      direction: 'keep it punchy',
    })
  })

  it('tolerates an empty direction', () => {
    expect(buildBlogRequest([], '')).toEqual({ script: '', direction: '' })
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
