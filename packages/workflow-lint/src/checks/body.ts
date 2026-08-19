import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'
import type { ExprSite } from '../model/slots.js'
import { TypeEnv } from '../model/types.js'

/**
 * 03: bodies carry paths and JSON, never file bytes — the linter warns when a
 * whole File ref (or list of refs) is placed in a pipeline body. Script and
 * island `with` values legitimately take File refs, so only body slots count.
 */
export function checkBody(def: Definition, sites: ExprSite[]): Finding[] {
  const env = new TypeEnv(def)
  const findings: Finding[] = []
  for (const site of sites) {
    if (site.slot.where !== 'body' && site.slot.where !== 'poll-body') continue
    if (!site.isWholeValue || !site.expr) continue
    const job = site.slot.jobId ? def.jobs[site.slot.jobId] : undefined
    const t = env.infer(site.expr, job)
    if (t.base === 'file') {
      const shape = t.list > 0 ? 'a list of File refs' : 'a whole File ref'
      findings.push({
        rule: 'file-ref-in-body',
        severity: 'warning',
        message: `\`${site.raw.trim()}\` puts ${shape} in a pipeline body — bodies carry paths, never refs (03)`,
        path: site.pointer,
        hint: t.list > 0 ? "pass pluck(list, 'path')" : 'pass ref.path',
      })
    }
  }
  return findings
}
