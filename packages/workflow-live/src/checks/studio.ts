import { unzipSync } from 'fflate'
import { isFileRef, isOffloaded, stepByKey, stepsOfJob, type RunRecord, type StepRow } from '../record.js'
import type { Checker } from '../report.js'

export const STUDIO_AUDIT_RUN = 'run_01M17CG3W0YTA4T0ZVRTD88VE7'

const get = (v: unknown, path: string[]): unknown => path.reduce<unknown>((acc, k) => (typeof acc === 'object' && acc !== null ? (acc as Record<string, unknown>)[k] : undefined), v)
const rowsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : Array.isArray(get(v, ['rows'])) ? (get(v, ['rows']) as unknown[]) : [])
const isScene = (row: unknown): boolean => typeof get(row, ['source']) === 'string' && typeof get(row, ['sourceIndex']) === 'number' && Array.isArray(get(row, ['spans']))
const trimSteps = (rec: RunRecord): StepRow[] => stepsOfJob(rec, 'per-scene').filter((s) => s.step === 'trim')

export function checkStudioCommon(rec: RunRecord, r: Checker): void {
  const run = rec.run
  // Every step that is neither green nor skipped — running, waiting, failed, cancelled — not just the failed ones.
  const nonGreenSteps = rec.steps.filter((s) => s.status !== 'succeeded' && s.status !== 'skipped').map((s) => `${s.key}:${s.status}`)
  r.expect('run.succeeded', run?.status === 'succeeded', { status: run?.status ?? null, runId: run?.runId ?? null, nonGreenSteps })
  const scenes = rowsOf(stepByKey(rec, 'director/0/scenes')?.outputs?.scenes)
  const firstBad = scenes.find((s) => !isScene(s)) ?? null
  r.expect('R.scenesCarrySourceSpans', scenes.length > 0 && scenes.every(isScene), { scenes: scenes.length, first: scenes[0] ?? null, firstBad })
  const sheetSteps = rec.steps.filter((s) => /^sheets\/\d+\/sheets$/.test(s.key) && s.status === 'succeeded')
  const drawn = sheetSteps.map((s) => (get(s.response, ['last', 'result', 'drawn']) ?? get(s.response, ['result', 'drawn']) ?? get(s.response, ['drawn'])) === true)
  r.expect('D2.sheetsDrawn', sheetSteps.length > 0 && drawn.every(Boolean), { sheetSteps: sheetSteps.map((s) => s.key), drawn })
  const trims = trimSteps(rec)
  const keeps = trims.map((s) => Array.isArray(s.outputs?.keep) ? (s.outputs!.keep as unknown[]).length : -1)
  r.expect('trim.keepRecorded', trims.length > 0 && trims.every((s) => s.status === 'succeeded') && keeps.every((n) => n > 0), { trims: trims.map((s) => s.key), keeps, statuses: trims.map((s) => `${s.key}:${s.status}`) })
  const o = run?.outputs ?? {}
  r.expect('outputs.shortBlogCoverAreFileRefs', isFileRef(o.short) && isFileRef(o.blog) && isFileRef(o.cover), { short: o.short ?? null, blog: o.blog ?? null, cover: o.cover ?? null })
  const transcribes = rec.steps.filter((s) => /^per-video\/\d+\/transcribe$/.test(s.key))
  r.expect('D16.wordsNotOffloaded', transcribes.length > 0 && transcribes.every((s) => !isOffloaded(s.outputs?.words) && s.outputs?.words !== undefined), transcribes.map((s) => ({ key: s.key, offloaded: isOffloaded(s.outputs?.words), hasWords: s.outputs?.words !== undefined })))
}

/**
 * Follows the live studio.workflow.yaml as of 2026-08-30 (apps#429/#430):
 * `blog/0/review` (island, skipped with the written post as the headless
 * fallback), `cover/0/direction` + `cover/0/review` (forms, both skipped),
 * `cover/0/render` (pipeline, succeeded) — the old `blog/0/edit` and
 * `pick/0/pick` steps no longer exist.
 */
export function checkStudioHeadless(rec: RunRecord, r: Checker): void {
  checkStudioCommon(rec, r)
  r.expect('run.headlessFlag', rec.run?.headless === true, { headless: rec.run?.headless ?? null })
  const blogReview: StepRow | undefined = stepByKey(rec, 'blog/0/review')
  r.expect('D11.blogReviewSkippedWithPost', blogReview?.status === 'skipped' && typeof blogReview.outputs?.post === 'string' && blogReview.outputs.post.length > 0, { status: blogReview?.status ?? 'absent', postLength: typeof blogReview?.outputs?.post === 'string' ? blogReview.outputs.post.length : null })
  const coverDirection: StepRow | undefined = stepByKey(rec, 'cover/0/direction')
  const coverReview: StepRow | undefined = stepByKey(rec, 'cover/0/review')
  r.expect('D11.coverFormsSkipped', coverDirection?.status === 'skipped' && coverReview?.status === 'skipped' && coverDirection.outputs != null && coverReview.outputs != null, { directionStatus: coverDirection?.status ?? 'absent', reviewStatus: coverReview?.status ?? 'absent', directionKeys: coverDirection?.outputs ? Object.keys(coverDirection.outputs) : [], reviewKeys: coverReview?.outputs ? Object.keys(coverReview.outputs) : [] })
  const coverRender: StepRow | undefined = stepByKey(rec, 'cover/0/render')
  r.expect('cover.rendered', coverRender?.status === 'succeeded' && isFileRef(coverRender.outputs?.cover), { status: coverRender?.status ?? 'absent', cover: coverRender?.outputs?.cover ?? null })
  const trimsAuto = trimSteps(rec)
  r.expect('D7.trimAutoAccepted', trimsAuto.length > 0 && trimsAuto.every((s) => s.status === 'succeeded'), trimsAuto.map((s) => `${s.key}:${s.status}`))
}

export function checkBlogZip(bytes: Uint8Array, r: Checker): void {
  let names: string[]
  try { names = Object.keys(unzipSync(bytes)) } catch (e) { return void r.expect('blog.zipReadable', false, String(e)) }
  const frames = names.filter((n) => /^images\/frame-\d+\.jpg$/.test(n))
  const posts = names.filter((n) => /\.md$/.test(n) && !n.includes('/'))
  r.expect('blog.zipHasFrames', frames.length > 0, { entries: names.length, frames: frames.length })
  r.expect('blog.zipHasOnePost', posts.length === 1, { entries: names.length, posts })
}
