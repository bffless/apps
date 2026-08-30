/**
 * Headless: Task 25 Step 2 — the driver's own hello run, a negative
 * (wrong-typed input) case, and — with `--dispatch` — the same workflow run
 * through GitHub Actions (`workflow-headless-run.yml`), proving the CI path
 * end to end. This walk opens no browser of its own: the driver runs as a
 * subprocess (local) or inside Actions (dispatch), so nothing here needs a
 * try/catch/finally — a throw is caught by the CLI. The one exception is the
 * dispatch artifact download, which runs under `report.guard` so a red job
 * reads as a FAIL on its rung rather than a BLOCK.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { checkHeadlessHello } from '../checks/hello-headless.js'
import { driverCliPath, outcomeOf, runDriver } from '../driver.js'
import { credentials } from '../env.js'
import { parseRecord } from '../record.js'
import type { Walk } from './index.js'

const run = promisify(execFile)

export const headless: Walk = async ({ args, env, report }) => {
  if (!credentials(env)) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing')
  if (!existsSync(driverCliPath())) return report.block(`driver CLI not built: ${driverCliPath()} — run pnpm --filter @bffless/workflow-headless build`)
  // Step 2a — the local driver
  const local = await runDriver({ harness: args.harness, target: 'hello/interactive', inputs: {}, out: join(args.out, 'local'), timeoutMs: Math.min(args.timeoutMs, 15 * 60_000), env })
  if (local.runId) report.run(local.runId)
  const kind = outcomeOf(local.code)
  if (kind === 'driver-fault' || kind === 'timeout') return report.block(`driver ${kind} (exit ${local.code}): ${local.stderr.slice(-400)}`)
  report.expect('driver.exit0', local.code === 0, { code: local.code, kind, stderrTail: local.code !== 0 ? local.stderr.slice(-400) : null })
  if (local.record) checkHeadlessHello(local.record, report)
  else report.expect('driver.wroteRunJson', false, 'no run.json')
  const posterPath = join(args.out, 'local/driver/outputs/poster.svg')
  report.expect('driver.savedPoster', existsSync(posterPath), posterPath)
  // Step 2b — negative: a wrong-typed input is refused before a run exists (exit 3)
  const bad = await runDriver({ harness: args.harness, target: 'hello/interactive', inputs: { greeting: 42 }, out: join(args.out, 'negative'), timeoutMs: 3 * 60_000, env })
  if (bad.runId) report.run(bad.runId) // a spend even though the check fails
  report.expect('driver.wrongTypeIsExit3', bad.code === 3 && bad.runId === undefined, { code: bad.code, runId: bad.runId ?? null })
  // Step 2c — the same through the dispatch workflow (the artifact is the proof)
  if (!args.dispatch) { report.note('--dispatch not given: workflow-headless-run.yml row not walked'); return }
  try { await run('gh', ['auth', 'status']) } catch { return report.block('gh is not authenticated (needed for --dispatch)') }
  // Adopt only our own run: "newest run ≠ before" would take anyone's concurrent
  // workflow_dispatch as ours. Filter by the authenticated login (gh 2.95 accepts
  // `-u @me` but returns `[]`) and by a creation floor taken just before the
  // dispatch — the login filter + `≠ before` make the 60 s skew margin safe.
  const login = (await run('gh', ['api', 'user', '-q', '.login'])).stdout.trim()
  if (!login) return report.block('gh api user returned no login (needed to find our dispatch run)')
  const listRuns = async (): Promise<{ databaseId: number; createdAt: string }[]> =>
    JSON.parse((await run('gh', ['run', 'list', '--repo', 'bffless/apps', '--workflow', 'workflow-headless-run.yml', '-u', login, '-e', 'workflow_dispatch', '--limit', '5', '--json', 'databaseId,createdAt'])).stdout || '[]')
  const before = (await listRuns())[0]?.databaseId
  const floor = Date.now() - 60_000
  await run('gh', ['workflow', 'run', 'workflow-headless-run.yml', '--repo', 'bffless/apps', '-f', 'workflow=hello/interactive', '-f', 'inputs={}', '-f', `harness_url=${args.harness}`, '-f', 'timeout_minutes=15', '-f', 'job_timeout_minutes=25'])
  let id = ''
  for (let i = 0; i < 30 && !id; i++) {
    await new Promise((r) => setTimeout(r, 5_000))
    const ours = (await listRuns()).find((r) => r.databaseId !== before && Date.parse(r.createdAt) >= floor)
    if (ours) id = String(ours.databaseId)
  }
  if (!id) return report.block('dispatch did not produce a new run within 150 s')
  report.note(`dispatch run https://github.com/bffless/apps/actions/runs/${id}`)
  const watched = await run('gh', ['run', 'watch', id, '--repo', 'bffless/apps', '--exit-status'], { maxBuffer: 1 << 24 }).then(() => 0, (e: { code?: number | string }) => (typeof e.code === 'number' ? e.code : 1))
  report.expect('dispatch.jobGreen', watched === 0, { runId: id, exit: watched })
  const dl = join(args.out, 'dispatch')
  await mkdir(dl, { recursive: true })
  // The workflow uploads `workflow-run-output` with `if: always()` because a red
  // job's failed.png/steps.log are the whole reason to look — so the artifact
  // usually exists on a red job and is still read below. When the job died
  // before the driver wrote anything, the download throws: one FAIL row for
  // one cause, then stop (`artifactHasRunJson` is not also recorded).
  const dl0 = await report.guard(['dispatch.artifactDownloaded'], async () => {
    await run('gh', ['run', 'download', id, '--repo', 'bffless/apps', '-n', 'workflow-run-output', '-D', dl])
    report.expect('dispatch.artifactDownloaded', true, dl)
  })
  if (!dl0) return
  const recordPath = join(dl, 'run.json')
  if (!existsSync(recordPath)) return void report.expect('dispatch.artifactHasRunJson', false, 'run.json missing from workflow-run-output')
  const rec = parseRecord(JSON.parse(await readFile(recordPath, 'utf8')))
  if (rec.run?.runId) report.run(rec.run.runId)
  checkHeadlessHello(rec, report.scoped('dispatch.'))
  const dispatchPosterPath = join(dl, 'outputs/poster.svg')
  report.expect('dispatch.savedPoster', existsSync(dispatchPosterPath), dispatchPosterPath)
}
