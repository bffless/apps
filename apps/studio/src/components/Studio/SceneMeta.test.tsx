import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SceneMeta } from './SceneMeta'
import type { Scene } from '../../lib/scenes'

const base: Scene = {
  id: 'scene-1',
  index: 0,
  sourceId: 'source-1',
  title: 'Intro',
  start: 0,
  end: 100,
  transcript: 'one two three four five six seven eight nine ten',
  status: 'pending',
  narrationSeconds: null,
}

describe('SceneMeta script stat', () => {
  it('uses the refined narration text once refined, not the transcript', () => {
    const refined: Scene = {
      ...base,
      refined: { segments: [{ text: 'one two three', start: 0, end: 30 }], cuts: [], source: 'ai' },
    }
    const { container } = render(<SceneMeta scene={refined} />)
    // transcript is 10 words, refined script is 3 → "10 → 3 words"
    expect(container.textContent).toContain('10 → 3 words')
  })

  it('pre-refine, reflects the transcript fallback (no reduction)', () => {
    const { container } = render(<SceneMeta scene={base} />)
    expect(container.textContent).toContain('10 → 10 words')
  })
})
