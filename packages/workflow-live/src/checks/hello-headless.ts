import { isFileRef, stepByKey, type RunRecord } from '../record.js'
import type { Checker } from '../report.js'

export function checkHeadlessHello(rec: RunRecord, r: Checker): void {
  const run = rec.run
  r.expect('run.succeeded', run?.status === 'succeeded', { status: run?.status ?? null, runId: run?.runId ?? null })
  r.expect('run.headlessFlag', run?.headless === true, { headless: run?.headless ?? null })
  const pick = stepByKey(rec, 'pick/0/choose')
  r.expect('D7.islandSelfSubmitted', pick?.status === 'succeeded' && pick.outputs !== null && pick.outputs !== undefined, { status: pick?.status ?? 'absent', outputs: pick?.outputs ? Object.keys(pick.outputs) : null })
  const review = stepByKey(rec, 'review/0/confirm')
  r.expect('D11.reviewSkippedWithOutputs', review?.status === 'skipped' && isFileRef(review.outputs?.cover), { status: review?.status ?? 'absent', cover: review?.outputs?.cover ?? null })
  r.expect('run.posterIsFileRef', isFileRef(run?.outputs?.poster), run?.outputs?.poster ?? null)
}
