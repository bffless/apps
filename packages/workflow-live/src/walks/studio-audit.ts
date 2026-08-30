import { STUDIO_AUDIT_RUN, checkStudioCommon } from '../checks/studio.js'
import { credentials } from '../env.js'
import { parseRecord } from '../record.js'
import { openSession } from '../session.js'
import type { Walk } from './index.js'

export const studioAudit: Walk = async ({ args, env, report }) => {
  const creds = credentials(env)
  if (!creds) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing')
  const runId = args.run ?? STUDIO_AUDIT_RUN
  const s = await openSession({ base: args.harness, out: args.out, credentials: creds })
  try {
    const res = await s.api.json(`/api/workflow/run?id=${encodeURIComponent(runId)}`)
    if (res.status !== 200) return report.block(`run read answered ${res.status}`)
    const rec = parseRecord(res.body)
    if (!rec.run) return report.block(`run ${runId} no longer exists — pass --run <id> of a by-hand Studio run`)
    report.run(runId)
    report.note('audit of a by-hand interactive run; no kickoff made')
    checkStudioCommon(rec, report)
    report.expect('run.interactiveFlag', rec.run.headless !== true, { headless: rec.run.headless ?? null })
  } catch (e) {
    await s.shot('99-failed')
    throw e
  } finally {
    await s.close()
  }
}
