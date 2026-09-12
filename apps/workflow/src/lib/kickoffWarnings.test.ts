import { describe, expect, it } from 'vitest'
import type { InputDef } from '@bffless/workflow-lint/definition'
import { evalKickoffWarnings, warningInputs } from './kickoffWarnings'
import type { FileRef } from './runner/types'

const take = (n: number): FileRef => ({
  path: `workflows/capture/capture/inputs/1/take-${n}.mp4`,
  name: `take-${n}.mp4`,
  contentType: 'video/mp4',
  size: 1024 * n,
  url: `/api/uploads/workflows/capture/capture/inputs/1/take-${n}.mp4`,
})

const inputs: Record<string, InputDef> = {
  recording: { type: 'file', accept: 'video/*', required: true },
  takes: { type: 'file', accept: 'video/*', list: true },
  interval: { type: 'number', default: 5, min: 0.5 },
}

// The issue's own example: a long recording at a short interval means
// thousands of stills, and the person should learn that before Start.
const stills = [
  {
    if: '${{ inputs.recording.duration / inputs.interval > 240 }}',
    message: 'About ${{ floor(inputs.recording.duration / inputs.interval) }} stills — past 150 MB the zip lists the sheets.',
  },
]

describe('warningInputs', () => {
  it('decorates file refs with the measured duration, null until measured; other inputs pass through', () => {
    const ctx = warningInputs(
      inputs,
      { recording: take(1), takes: [take(2), take(3)], interval: 5 },
      { [take(1).path]: 1234.5, [take(3).path]: 60 },
    )
    expect(ctx.recording).toEqual({ ...take(1), duration: 1234.5 })
    expect(ctx.takes).toEqual([
      { ...take(2), duration: null },
      { ...take(3), duration: 60 },
    ])
    expect(ctx.interval).toBe(5)
  })

  it('leaves an empty or non-ref file value alone and reads absent inputs as null', () => {
    const ctx = warningInputs(inputs, { takes: [] }, {})
    expect(ctx).toEqual({ recording: null, takes: [], interval: null })
  })
})

describe('evalKickoffWarnings', () => {
  it('shows a warning whose if holds, with its message rendered through the shared engine', () => {
    const ctx = warningInputs(inputs, { recording: take(1), interval: 5 }, { [take(1).path]: 1234.5 })
    expect(evalKickoffWarnings(stills, ctx, 'capture')).toEqual([
      { severity: 'warning', message: 'About 246 stills — past 150 MB the zip lists the sheets.' },
    ])
  })

  it('stays silent while the duration is unmeasured or the interval is wide enough', () => {
    const unmeasured = warningInputs(inputs, { recording: take(1), interval: 5 }, {})
    expect(evalKickoffWarnings(stills, unmeasured, 'capture')).toEqual([])
    const wide = warningInputs(inputs, { recording: take(1), interval: 10 }, { [take(1).path]: 1234.5 })
    expect(evalKickoffWarnings(stills, wide, 'capture')).toEqual([])
  })

  it('reads impl, and takes the bare-if spelling every other if takes (01)', () => {
    const shown = evalKickoffWarnings(
      [{ if: "impl.alias == 'capture'", message: 'Posting to ${{ impl.api }}' }],
      {},
      'capture',
    )
    expect(shown).toEqual([{ severity: 'warning', message: 'Posting to /api/capture' }])
    expect(evalKickoffWarnings([{ if: "impl.alias == 'capture'", message: 'x' }], {}, 'other')).toEqual([])
  })

  it('degrades an entry it cannot evaluate to a notice naming the reason, and keeps going', () => {
    const shown = evalKickoffWarnings(
      [
        { if: '${{ success() }}', message: 'never' },
        { if: '${{ ceil(1.5) > 1 }}', message: 'never' },
        { if: 'true', message: 'still shown' },
      ],
      {},
      'capture',
    )
    expect(shown).toEqual([
      { severity: 'notice', message: 'Warning 1 could not be evaluated — success() has nothing to report before a run starts' },
      { severity: 'notice', message: 'Warning 2 could not be evaluated — unknown function ceil()' },
      { severity: 'warning', message: 'still shown' },
    ])
  })

  it('renders a non-string message value the way interpolation would', () => {
    expect(evalKickoffWarnings([{ if: 'true', message: '${{ inputs.n }}' }], { n: 42 }, undefined)).toEqual([
      { severity: 'warning', message: '42' },
    ])
  })
})
