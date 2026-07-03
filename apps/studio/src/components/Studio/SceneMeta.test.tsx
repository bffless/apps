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
}

describe('SceneMeta cut stats', () => {
  it('reads the refined cuts once refined, not the director baseline', () => {
    const refined: Scene = {
      ...base,
      cuts: [{ start: 0, end: 50 }], // stale baseline — must NOT be read
      refined: { cuts: [{ start: 10, end: 30 }], source: 'manual' },
    }
    const { container } = render(<SceneMeta scene={refined} />)
    // 100s footage, 20s cut → 1:40 → 1:20, 80% kept
    expect(container.textContent).toContain('1 · −0:20.0')
    expect(container.textContent).toContain('80% kept')
  })

  it('pre-refine, reflects the director baseline cuts', () => {
    const { container } = render(<SceneMeta scene={{ ...base, cuts: [{ start: 0, end: 10 }] }} />)
    expect(container.textContent).toContain('−0:10.0')
  })

  it('shows "none" with no cuts anywhere', () => {
    const { container } = render(<SceneMeta scene={base} />)
    expect(container.textContent).toContain('none')
  })
})
