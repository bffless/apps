/**
 * Park a `hello/interactive` run on one of its interactive steps **through the
 * page tools** (the member's browser drives; spec 10 D21), wait for the row to
 * say what the page says (the endpoint reads rows — Phase 2 as shipped), and
 * close the browser so the lease lapses within 60 s. Shared by the `mcp` walk
 * (island) and the `mcp-app` walk (island, then form); `--park-only` in both.
 */
import { callPageTool, waitForPageTools } from '@bffless/workflow-headless'
import type { Session } from './session.js'

export const ISLAND_STEP = 'pick/0/choose'
export const FORM_STEP = 'review/0/confirm'
export type ParkUntil = 'island' | 'form'
export interface Parked { runId: string; step: string; kind: ParkUntil; waitingOn: Array<{ key: string; kind: string }>; rowStatus: string; rowWaitMs: number; startedOk: boolean; waitingOk: boolean }

const INPUTS = { greeting: 'Hello', names: ['world', 'studio'] }
const ISLAND_VALUES = { line: 'Hello, world!', index: 0 }

export async function parkHelloRun(s: Session, until: ParkUntil, say: (line: string) => void): Promise<Parked> {
  const step = until === 'island' ? ISLAND_STEP : FORM_STEP
  try {
    await waitForPageTools(s.page, { timeoutMs: 30_000 })
    const started = await callPageTool(s.page, 'workflow.start', { impl: 'hello', workflow: 'interactive', inputs: INPUTS })
    const runId = String(((started.structuredContent ?? {}) as { runId?: string }).runId ?? '')
    let waiting = await callPageTool(s.page, 'workflow.await', { until: 'waiting', timeoutMs: 120_000 })
    if (until === 'form') {
      await callPageTool(s.page, 'workflow.submitStep', { step: ISLAND_STEP, values: ISLAND_VALUES })
      waiting = await callPageTool(s.page, 'workflow.await', { until: 'waiting', timeoutMs: 180_000 }) // the page runs the card script in between
    }
    const waitingOn = ((waiting.structuredContent ?? {}) as { waitingOn?: Array<{ key: string; kind: string }> }).waitingOn ?? []
    let rowStatus = ''
    const rowStart = Date.now()
    while (runId !== '' && Date.now() - rowStart < 30_000 && rowStatus !== 'waiting') {
      const record = await s.api.json(`/api/workflow/run?id=${encodeURIComponent(runId)}`)
      const rows = ((record.body as { steps?: Array<Record<string, unknown>> } | null)?.steps ?? []).map((r) => (r.fields && typeof r.fields === 'object' ? (r.fields as Record<string, unknown>) : r))
      rowStatus = String(rows.find((r) => r.key === step)?.status ?? '')
      if (rowStatus !== 'waiting') await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    say(`parked ${runId} on ${step} (${rowStatus})`)
    await s.shot(`01-parked-${until}`)
    return { runId, step, kind: until, waitingOn, rowStatus, rowWaitMs: Date.now() - rowStart, startedOk: !started.isError, waitingOk: !waiting.isError }
  } finally {
    await s.close() // the driver goes away; the lease lapses within 60 s
  }
}
