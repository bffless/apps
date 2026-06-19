import { describe, it, expect } from 'vitest'
import { maxPhaseFor, resolvePhase } from './studioRoute'
import { freshWorkingState } from '../store/studioSlice'

function prepped(opts: { built?: boolean } = {}) {
  const w = freshWorkingState()
  w.sources = [{ id: 's1', order: 0, fileName: 'a.mp4', duration: 10, sourceUrl: 'u', audioUrl: 'a', audioPeaks: [], words: [], transcribeJobId: null, stageProgress: { upload: { status: 'done' }, extract: { status: 'done' }, transcribe: { status: 'done' } } }]
  for (const id of ['thumbnails', 'clone', 'director'] as const) w.stageProgress[id] = { status: 'done' }
  w.scenes = [{ id: 'sc1', status: opts.built ? 'built' : 'pending' } as never]
  return w
}

describe('maxPhaseFor', () => {
  it('is prep for a fresh project (no source)', () => {
    expect(maxPhaseFor(freshWorkingState())).toBe('prep')
  })
  it('is build when prepped but not all scenes built', () => {
    expect(maxPhaseFor(prepped())).toBe('build')
  })
  it('is export when every scene is built', () => {
    expect(maxPhaseFor(prepped({ built: true }))).toBe('export')
  })
})

describe('resolvePhase', () => {
  it('redirects an undefined phase to the furthest reached', () => {
    expect(resolvePhase(prepped(), undefined)).toEqual({ redirectTo: 'build' })
  })
  it('redirects a garbage phase to the furthest reached', () => {
    expect(resolvePhase(freshWorkingState(), 'nonsense')).toEqual({ redirectTo: 'prep' })
  })
  it('clamps a too-far phase down to the max', () => {
    expect(resolvePhase(freshWorkingState(), 'build')).toEqual({ redirectTo: 'prep' })
    expect(resolvePhase(prepped(), 'export')).toEqual({ redirectTo: 'build' })
  })
  it('renders an allowed phase as-is', () => {
    expect(resolvePhase(prepped(), 'prep')).toEqual({ phase: 'prep' })
    expect(resolvePhase(prepped(), 'build')).toEqual({ phase: 'build' })
    expect(resolvePhase(prepped({ built: true }), 'export')).toEqual({ phase: 'export' })
  })
})
