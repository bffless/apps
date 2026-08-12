import { describe, it, expect } from 'vitest'
import { resolveCoreChoice } from './ffmpeg'

describe('resolveCoreChoice', () => {
  it('defaults by isolation capability', () => {
    expect(resolveCoreChoice('', null, true)).toBe('mt')
    expect(resolveCoreChoice('', null, false)).toBe('st')
  })

  it('a ?ffmpegCore override beats the capability default', () => {
    expect(resolveCoreChoice('?ffmpegCore=st', null, true)).toBe('st')
    expect(resolveCoreChoice('?ffmpegCore=mt', null, false)).toBe('mt')
  })

  it('a persisted override applies on later navigations without the param', () => {
    expect(resolveCoreChoice('', 'st', true)).toBe('st')
    expect(resolveCoreChoice('', 'mt', false)).toBe('mt')
  })

  it('the URL param wins over a stale stored value', () => {
    expect(resolveCoreChoice('?ffmpegCore=mt', 'st', true)).toBe('mt')
  })

  it('garbage values fall through to the default', () => {
    expect(resolveCoreChoice('?ffmpegCore=turbo', 'nope', true)).toBe('mt')
    expect(resolveCoreChoice('?ffmpegCore=turbo', 'nope', false)).toBe('st')
  })
})
