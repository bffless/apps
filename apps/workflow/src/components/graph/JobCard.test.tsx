/**
 * `matrixItemLabel` and the matrix item `<select>` it feeds (08): hello's
 * matrix items are plain strings, but the Studio port's (`per-scene`) are
 * objects (`{ number, title, source, ... }`) — a naive `String(value)` on one
 * of those renders `[object Object]` in the selector. This pins the readable
 * label both as a pure function and through the rendered `<select>`.
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Definition, RunState } from '../../lib/runner/types'
import { matrixItemLabel } from './geometry'
import { JobCard } from './JobCard'

const def: Definition = toDefinition({
  name: 'Scenes',
  on: { manual: { inputs: { scenes: { type: 'json' } } } },
  jobs: {
    'per-scene': {
      strategy: { matrix: { scene: '${{ inputs.scenes }}' }, 'max-parallel': 2 },
      steps: [{ id: 'inputs', uses: 'script', with: { src: 'scripts/inputs.js' } }],
    },
  },
})

function job() {
  const j = def.jobs['per-scene']
  if (!j) throw new Error('no such job per-scene')
  return j
}

function state(items: Record<string, unknown>[]): RunState {
  return {
    runId: 'run_TEST',
    impl: 'studio',
    workflow: 'scenes',
    status: 'running',
    headless: false,
    unattended: false,
    inputs: {},
    steps: {},
    expansions: { 'per-scene': { total: items.length, items } },
    annotations: [],
    startedAt: 1_000,
  }
}

describe('matrixItemLabel', () => {
  it('returns a string or number value as itself', () => {
    expect(matrixItemLabel('World', 0)).toBe('World')
    expect(matrixItemLabel(3, 0)).toBe('3')
  })

  it("reads an object's title/name/label/id instead of `[object Object]`", () => {
    expect(matrixItemLabel({ number: 3, title: 'Intro', source: 'a.mp4' }, 0)).toBe('Intro')
    expect(matrixItemLabel({ id: 'scene-3' }, 0)).toBe('scene-3')
  })

  it('falls back to its position when nothing on the object reads as a name', () => {
    expect(matrixItemLabel({ number: 3 }, 2)).toBe('#3')
  })

  it("uses a File ref's own name", () => {
    const fileRef = { path: 'x/y.mov', name: 'take.mov', url: '/api/uploads/x/y.mov' }
    expect(matrixItemLabel(fileRef, 0)).toBe('take.mov')
  })
})

describe('JobCard (matrix item selector)', () => {
  it('shows a readable label for an object matrix item, not `[object Object]`', () => {
    render(
      <JobCard
        job={job()}
        col={0}
        row={0}
        mode="run"
        state={state([
          { scene: { number: 1, title: 'Intro', source: 'a.mp4' } },
          { scene: { number: 2, title: 'Outro', source: 'b.mp4' } },
        ])}
        onPick={vi.fn()}
      />,
    )

    const select = screen.getByLabelText('Matrix item of per-scene') as HTMLSelectElement
    const options = [...select.options].map((o) => o.textContent)

    expect(options).toEqual(['scene: Intro', 'scene: Outro'])
    expect(options.join(' ')).not.toContain('[object Object]')
  })
})
