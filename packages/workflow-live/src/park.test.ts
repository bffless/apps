import { describe, expect, it, vi } from 'vitest'
vi.mock('@bffless/workflow-headless', () => {
  let awaits = 0
  return {
    waitForPageTools: vi.fn(async () => undefined),
    callPageTool: vi.fn(async (_page: unknown, name: string) => {
      if (name === 'workflow.start') return { structuredContent: { runId: 'run_1' } }
      if (name === 'workflow.await') {
        awaits += 1
        return { structuredContent: { waitingOn: [{ key: awaits === 2 ? 'review/0/confirm' : 'pick/0/choose', kind: 'island' }] } }
      }
      if (name === 'workflow.submitStep') return { structuredContent: {} }
      throw new Error(name)
    }),
  }
})
import { callPageTool } from '@bffless/workflow-headless'
import { parkHelloRun } from './park.js'

const session = (rowStatus: string) => ({ page: {}, api: { json: vi.fn(async () => ({ status: 200, body: { steps: [{ key: 'pick/0/choose', status: rowStatus }, { key: 'review/0/confirm', status: rowStatus }] } })) }, close: vi.fn(async () => undefined), shot: vi.fn(async () => undefined) }) as never

describe('parkHelloRun', () => {
  it('parks on the island: start → await, then closes the browser', async () => {
    const parked = await parkHelloRun(session('waiting'), 'island', () => undefined)
    expect(parked).toMatchObject({ runId: 'run_1', step: 'pick/0/choose', kind: 'island', rowStatus: 'waiting' })
    expect(vi.mocked(callPageTool).mock.calls.map((c) => c[1])).toEqual(['workflow.start', 'workflow.await'])
  })
  it('parks on the form: submits the island through the page tools first', async () => {
    vi.mocked(callPageTool).mockClear()
    const parked = await parkHelloRun(session('waiting'), 'form', () => undefined)
    expect(parked.step).toBe('review/0/confirm')
    expect(vi.mocked(callPageTool).mock.calls.map((c) => c[1])).toEqual(['workflow.start', 'workflow.await', 'workflow.submitStep', 'workflow.await'])
  })
})
