/**
 * Studio headless: Task 25 Step 4 — kick off the Studio workflow headlessly
 * against the pinned onboarding-rules.mp4 fixture, then assert the headless
 * contract (checkStudioHeadless) plus the driver's saved outputs (short.mp4,
 * cover.*, blog.zip). No browser is opened here — the driver runs as a
 * subprocess — so nothing needs a try/finally wrapper.
 */
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkBlogZip, checkStudioHeadless } from '../checks/studio.js'
import { driverCliPath, outcomeOf, runDriver, type DriverOutcome } from '../driver.js'
import { credentials } from '../env.js'
import { ensureClip } from '../fixture.js'
import type { Walk } from './index.js'

const MAX_KICKOFFS = 2   // one, plus one retry after a driver fault — never after a run failure

export const studioHeadless: Walk = async ({ args, env, report }) => {
  if (!credentials(env)) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing')
  if (!existsSync(driverCliPath())) return report.block(`driver CLI not built: ${driverCliPath()} — run pnpm --filter @bffless/workflow-headless build`)
  let clip
  try { clip = await ensureClip(args.clip) } catch (e) { return report.block(String(e)) }
  report.note(`clip ${clip.path}${clip.sha256 ? ` sha256 ${clip.sha256.slice(0, 12)}` : ''}`)
  const inputs = { recordings: [clip.path], direction: '', write_blog: true, cover: true, cover_direction: '', accept_cuts: true }
  let outcome: DriverOutcome | undefined
  let lastAttempt = 0
  for (let attempt = 1; attempt <= MAX_KICKOFFS; attempt++) {
    lastAttempt = attempt
    report.kickoff()
    report.note(`kickoff ${attempt}: WhisperX + Gemini (director, refiner ×scenes) + Claude (describe, blog) + nano-banana ×2`)
    outcome = await runDriver({ harness: args.harness, target: 'workflow-studio/studio', inputs, out: join(args.out, `attempt-${attempt}`), timeoutMs: args.timeoutMs, env })
    if (outcome.runId) report.run(outcome.runId)
    const kind = outcomeOf(outcome.code)
    if (kind === 'driver-fault' || kind === 'timeout') { report.note(`attempt ${attempt}: driver ${kind} (exit ${outcome.code})`); continue }
    break
  }
  if (!outcome) return report.block('no attempt ran')
  const kind = outcomeOf(outcome.code)
  if (kind === 'driver-fault' || kind === 'timeout') return report.block(`driver ${kind} after ${MAX_KICKOFFS} attempts: ${outcome.stderr.slice(-400)}`)
  report.expect('driver.exit0', outcome.code === 0, { code: outcome.code, kind, stderrTail: outcome.code !== 0 ? outcome.stderr.slice(-400) : null })
  if (!outcome.record) return void report.expect('driver.wroteRunJson', false, 'no run.json')
  checkStudioHeadless(outcome.record, report)
  const outputs = join(args.out, `attempt-${lastAttempt}`, 'driver', 'outputs')
  const files = existsSync(outputs) ? readdirSync(outputs) : []
  report.expect('driver.savedShort', files.includes('short.mp4'), { dir: outputs, files })
  report.expect('driver.savedCover', files.some((f) => /^cover\.(jpe?g|png|webp)$/.test(f)), { dir: outputs, files })
  const zip = files.find((f) => f === 'blog.zip')
  if (zip) checkBlogZip(new Uint8Array(await readFile(join(outputs, zip))), report)
  else report.expect('driver.savedBlogZip', false, { dir: outputs, files })
}
