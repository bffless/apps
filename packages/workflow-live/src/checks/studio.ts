import { isFileRef, isOffloaded, stepByKey, stepsOfJob, type RunRecord, type StepRow } from '../record.js'
import type { Checker } from '../report.js'

export const STUDIO_AUDIT_RUN = 'run_01M17CG3W0YTA4T0ZVRTD88VE7'

const get = (v: unknown, path: string[]): unknown => path.reduce<unknown>((acc, k) => (typeof acc === 'object' && acc !== null ? (acc as Record<string, unknown>)[k] : undefined), v)
const rowsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : Array.isArray(get(v, ['rows'])) ? (get(v, ['rows']) as unknown[]) : [])

export function checkStudioCommon(rec: RunRecord, r: Checker): void {
  const run = rec.run
  const failedSteps = rec.steps.filter((s) => s.status === 'failed' || s.status === 'error').map((s) => s.key)
  r.expect('run.succeeded', run?.status === 'succeeded', { status: run?.status ?? null, runId: run?.runId ?? null, failedSteps })
  const scenes = rowsOf(stepByKey(rec, 'director/0/scenes')?.outputs?.scenes)
  r.expect('R.scenesCarrySourceSpans', scenes.length > 0 && scenes.every((s) => typeof get(s, ['source']) === 'string' && typeof get(s, ['sourceIndex']) === 'number' && Array.isArray(get(s, ['spans']))), { scenes: scenes.length, first: scenes[0] ?? null })
  const sheetSteps = rec.steps.filter((s) => /^sheets\/\d+\/sheets$/.test(s.key) && s.status === 'succeeded')
  const drawn = sheetSteps.map((s) => (get(s.response, ['last', 'result', 'drawn']) ?? get(s.response, ['result', 'drawn']) ?? get(s.response, ['drawn'])) === true)
  r.expect('D2.sheetsDrawn', sheetSteps.length > 0 && drawn.every(Boolean), { sheetSteps: sheetSteps.map((s) => s.key), drawn })
  const trims = rec.steps.filter((s) => /^per-scene\/\d+\/trim$/.test(s.key))
  const keeps = trims.map((s) => Array.isArray(s.outputs?.keep) ? (s.outputs!.keep as unknown[]).length : -1)
  r.expect('trim.keepRecorded', trims.length > 0 && trims.every((s) => s.status === 'succeeded') && keeps.every((n) => n > 0), { trims: trims.map((s) => s.key), keeps })
  const o = run?.outputs ?? {}
  r.expect('outputs.shortBlogCoverAreFileRefs', isFileRef(o.short) && isFileRef(o.blog) && isFileRef(o.cover), { short: o.short ?? null, blog: o.blog ?? null, cover: o.cover ?? null })
  const transcribes = rec.steps.filter((s) => /^per-video\/\d+\/transcribe$/.test(s.key))
  r.expect('D16.wordsNotOffloaded', transcribes.length > 0 && transcribes.every((s) => !isOffloaded(s.outputs?.words)), transcribes.map((s) => ({ key: s.key, offloaded: isOffloaded(s.outputs?.words) })))
}

export function checkStudioHeadless(rec: RunRecord, r: Checker): void {
  checkStudioCommon(rec, r)
  r.expect('run.headlessFlag', rec.run?.headless === true, { headless: rec.run?.headless ?? null })
  const edit: StepRow | undefined = stepByKey(rec, 'blog/0/edit')
  r.expect('D11.editSkippedWithPost', edit?.status === 'skipped' && typeof edit.outputs?.post === 'string' && edit.outputs.post.length > 0, { status: edit?.status ?? 'absent', postLength: typeof edit?.outputs?.post === 'string' ? edit.outputs.post.length : null })
  const pick = stepByKey(rec, 'pick/0/pick')
  r.expect('D11.pickSkippedWithCover', pick?.status === 'skipped' && isFileRef(pick.outputs?.cover), { status: pick?.status ?? 'absent', cover: pick?.outputs?.cover ?? null })
  const trimsAuto = stepsOfJob(rec, 'per-scene').filter((s) => s.step === 'trim')
  r.expect('D7.trimAutoAccepted', trimsAuto.every((s) => s.status === 'succeeded'), trimsAuto.map((s) => `${s.key}:${s.status}`))
}
