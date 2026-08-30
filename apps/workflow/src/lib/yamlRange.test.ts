/**
 * The YAML drawer's locator (apps#449): a job, a step, or a matrix job's
 * `strategy`, as the source lines the drawer marks — checked against the
 * hello example by line number, so a reshuffle of that file is caught here
 * rather than as a marker on the wrong block.
 */
import { describe, expect, it } from 'vitest'
import helloYaml from '../../docs/spec/examples/hello.workflow.yaml?raw'
import { describeRanges, isMarked, locateYamlBlocks } from './yamlRange'

describe('locateYamlBlocks', () => {
  it('marks a job from its key to the end of its value', () => {
    expect(locateYamlBlocks(helloYaml, { job: 'greet' })).toEqual([{ from: 19, to: 34 }])
    expect(locateYamlBlocks(helloYaml, { job: 'confirm' })).toEqual([{ from: 77, to: 92 }])
  })

  it('marks a step by its position in the job, including its `- id:` line', () => {
    expect(locateYamlBlocks(helloYaml, { job: 'greet', step: 0 })).toEqual([{ from: 25, to: 32 }])
    expect(locateYamlBlocks(helloYaml, { job: 'flaky', step: 1 })).toEqual([{ from: 68, to: 75 }])
  })

  it("adds the job's `strategy` block for a matrix leg, in source order", () => {
    expect(locateYamlBlocks(helloYaml, { job: 'greet', step: 0, strategy: true })).toEqual([
      { from: 21, to: 23 },
      { from: 25, to: 32 },
    ])
  })

  it('ignores a strategy request on a job that has none', () => {
    expect(locateYamlBlocks(helloYaml, { job: 'slow', step: 0, strategy: true })).toEqual([{ from: 40, to: 55 }])
  })

  it('falls back to the job block for a step the job does not have', () => {
    expect(locateYamlBlocks(helloYaml, { job: 'slow', step: 7 })).toEqual([{ from: 36, to: 58 }])
  })

  it('finds nothing for an unknown job, a jobless document, or a snapshot that will not parse', () => {
    expect(locateYamlBlocks(helloYaml, { job: 'nope' })).toEqual([])
    expect(locateYamlBlocks('name: x\n', { job: 'greet' })).toEqual([])
    expect(locateYamlBlocks('jobs: [\n', { job: 'greet' })).toEqual([])
    expect(locateYamlBlocks('', { job: 'greet' })).toEqual([])
  })

  it('handles a job whose value is empty', () => {
    expect(locateYamlBlocks('jobs:\n  greet:\n  other:\n    steps: []\n', { job: 'greet' })).toEqual([
      { from: 2, to: 2 },
    ])
  })
})

describe('isMarked / describeRanges', () => {
  it('reads membership inclusively at both ends', () => {
    const ranges = [{ from: 21, to: 23 }]
    expect(isMarked(ranges, 20)).toBe(false)
    expect(isMarked(ranges, 21)).toBe(true)
    expect(isMarked(ranges, 23)).toBe(true)
    expect(isMarked(ranges, 24)).toBe(false)
  })

  it('describes what it marked', () => {
    expect(describeRanges([])).toBeUndefined()
    expect(describeRanges([{ from: 2, to: 2 }])).toBe('line 2')
    expect(describeRanges([{ from: 25, to: 32 }])).toBe('lines 25–32')
    expect(describeRanges([{ from: 21, to: 23 }, { from: 25, to: 32 }])).toBe('lines 21–23, 25–32')
  })
})
