// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { newRunId } from '../lib/runner/ids'
import { RUN_ID_PATTERN, mintRunId, runIdTime, workflowId } from './ids'

describe('workflowId', () => {
  it('reads a workflow id off its file name exactly as the page does', () => {
    expect(workflowId('interactive.workflow.yaml')).toBe('interactive')
    expect(workflowId('long-to-short.yaml')).toBe('long-to-short')
    expect(workflowId('/w/hello/.bffless/workflows/hello.workflow.yml')).toBe('hello')
  })
})

describe('mintRunId', () => {
  it('mints the page’s run id shape, with the minting time readable back out of it', () => {
    const id = mintRunId(1_756_800_000_000, () => 0)
    expect(id).toMatch(RUN_ID_PATTERN)
    expect(runIdTime(id)).toBe(1_756_800_000_000)
  })

  it('is the engine’s own id shape (`lib/runner/ids.ts`), so a driven run is indistinguishable from a page-started one', () => {
    expect(newRunId()).toMatch(RUN_ID_PATTERN)
    expect(mintRunId(Date.now())).toMatch(RUN_ID_PATTERN)
  })

  it('draws 16 random characters, so two ids minted in the same millisecond differ', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintRunId(1_756_800_000_000)))
    expect(ids.size).toBe(200)
  })
})

describe('runIdTime', () => {
  it('is null for anything that is not a run id', () => {
    expect(runIdTime('nope')).toBeNull()
    expect(runIdTime('')).toBeNull()
    expect(runIdTime('run_01TEST')).toBeNull()
  })
})
