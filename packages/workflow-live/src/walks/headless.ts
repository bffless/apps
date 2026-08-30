/**
 * Headless: Task 25 Step 2 — the driver's own hello run, a negative
 * (wrong-typed input) case, and — with `--dispatch` — the same workflow run
 * through GitHub Actions (`workflow-headless-run.yml`), proving the CI path
 * end to end. This walk opens no browser of its own: the driver runs as a
 * subprocess (local) or inside Actions (dispatch), so nothing here needs a
 * try/catch/finally — a throw is caught by the CLI.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { checkHeadlessHello } from '../checks/hello-headless.js'
import { outcomeOf, runDriver } from '../driver.js'
import { credentials } from '../env.js'
import { parseRecord } from '../record.js'
import type { Walk } from './index.js'

const run = promisify(execFile)

export const headless: Walk = async ({ args, env, report }) => {
  if (!credentials(env)) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing')
  // Step 2a — the local driver
  const local = await runDriver({ harness: args.harness, target: 'hello/interactive', inputs: {}, out: join(args.out, 'local'), timeoutMs: Math.min(args.timeoutMs, 15 * 60_000), env })
  if (local.runId) report.run(local.runId)
  const kind = outcomeOf(local.code)
  if (kind === 'driver-fault' || kind === 'timeout') return report.block(`driver ${kind} (exit ${local.code}): ${local.stderr.slice(-400)}`)
  report.expect('driver.exit0', local.code === 0, { code: local.code, kind })
  if (local.record) checkHeadlessHello(local.record, report)
  else report.expect('driver.wroteRunJson', false, 'no run.json')
  report.expect('driver.savedPoster', existsSync(join(args.out, 'local/driver/outputs/poster.svg')), 'outputs/poster.svg')
  // Step 2b — negative: a wrong-typed input is refused before a run exists (exit 3)
  const bad = await runDriver({ harness: args.harness, target: 'hello/interactive', inputs: { greeting: 42 }, out: join(args.out, 'negative'), timeoutMs: 3 * 60_000, env })
  report.expect('driver.wrongTypeIsExit3', bad.code === 3 && bad.runId === undefined, { code: bad.code, runId: bad.runId ?? null })
  // Step 2c — the same through the dispatch workflow (the artifact is the proof)
  if (!args.dispatch) { report.note('--dispatch not given: workflow-headless-run.yml row not walked'); return }
  try { await run('gh', ['auth', 'status']) } catch { return report.block('gh is not authenticated (needed for --dispatch)') }
  const before = (await run('gh', ['run', 'list', '--repo', 'bffless/apps', '--workflow', 'workflow-headless-run.yml', '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId'])).stdout.trim()
  await run('gh', ['workflow', 'run', 'workflow-headless-run.yml', '--repo', 'bffless/apps', '-f', 'workflow=hello/interactive', '-f', 'inputs={}', '-f', `harness_url=${args.harness}`, '-f', 'timeout_minutes=15', '-f', 'job_timeout_minutes=25'])
  let id = ''
  for (let i = 0; i < 30 && !id; i++) {
    await new Promise((r) => setTimeout(r, 5_000))
    const latest = (await run('gh', ['run', 'list', '--repo', 'bffless/apps', '--workflow', 'workflow-headless-run.yml', '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId'])).stdout.trim()
    if (latest && latest !== before) id = latest
  }
  if (!id) return report.block('dispatch did not produce a new run within 150 s')
  report.note(`dispatch run https://github.com/bffless/apps/actions/runs/${id}`)
  const watched = await run('gh', ['run', 'watch', id, '--repo', 'bffless/apps', '--exit-status']).then(() => 0, (e: { code?: number }) => e.code ?? 1)
  report.expect('dispatch.jobGreen', watched === 0, { runId: id, exit: watched })
  const dl = join(args.out, 'dispatch')
  await mkdir(dl, { recursive: true })
  await run('gh', ['run', 'download', id, '--repo', 'bffless/apps', '-n', 'workflow-run-output', '-D', dl])
  const recordPath = join(dl, 'run.json')
  if (!existsSync(recordPath)) return void report.expect('dispatch.artifactHasRunJson', false, 'run.json missing from workflow-run-output')
  const rec = parseRecord(JSON.parse(await readFile(recordPath, 'utf8')))
  if (rec.run?.runId) report.run(rec.run.runId)
  checkHeadlessHello(rec, report.scoped('dispatch.'))
  report.expect('dispatch.savedPoster', existsSync(join(dl, 'outputs/poster.svg')), 'outputs/poster.svg')
}
