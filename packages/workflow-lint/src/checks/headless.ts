import type { Finding } from '../findings.js'
import type { Definition, Job, Step } from '../model/definition.js'
import type { ExprSite } from '../model/slots.js'
import { collectRefs } from './refs.js'

function skipOutputs(step: Step): Record<string, unknown> | 'bare-skip' | undefined {
  const h = step.raw.headless
  if (h === 'skip') return 'bare-skip'
  if (h != null && typeof h === 'object' && h.mode === 'skip') {
    return (h.outputs ?? {}) as Record<string, unknown>
  }
  return undefined
}

/** Output names of `step` referenced by later expressions of the same job (incl. job outputs). */
function referencedOutputs(job: Job, step: Step, sites: ExprSite[]): Map<string, string> {
  const refs = new Map<string, string>() // name → pointer of one referencing site
  for (const site of sites) {
    if (!site.expr || site.slot.jobId !== job.id) continue
    const later =
      site.slot.where === 'job-output' || (site.slot.stepIndex ?? -1) > step.index
    if (!later) continue
    for (const ref of collectRefs(site.expr).refs) {
      if (ref.root !== 'steps') continue
      const [id, kind, name] = ref.path
      if (id === step.id && kind === 'outputs' && typeof name === 'string' && !refs.has(name)) {
        refs.set(name, site.pointer)
      }
    }
  }
  return refs
}

export function checkHeadless(def: Definition, sites: ExprSite[]): Finding[] {
  const findings: Finding[] = []
  for (const job of Object.values(def.jobs)) {
    for (const step of job.steps) {
      if (step.uses !== 'island' && step.uses !== 'form') continue
      const pointer = `/jobs/${job.id}/steps/${step.index}`

      if (step.raw.headless == null) {
        findings.push({
          rule: 'interactive-headless',
          severity: 'notice',
          message:
            `${step.uses} step \`${step.id}\` is not headless-safe — a headless run fails fast here (07); ` +
            'declare headless: skip | auto',
          path: pointer,
        })
        continue
      }

      const skip = skipOutputs(step)
      if (skip === undefined) continue // mode auto — nothing to check statically
      for (const [name, at] of referencedOutputs(job, step, sites)) {
        const provided = skip !== 'bare-skip' && name in skip
        if (!provided) {
          findings.push({
            rule: 'headless-skip-outputs',
            severity: 'error',
            message:
              `\`steps.${step.id}.outputs.${name}\` is referenced (at ${at}) but headless: skip ` +
              `gives it no value — a headless run would leave it null (07); add it to headless.outputs`,
            path: `${pointer}/headless`,
          })
        }
      }
    }
  }
  return findings
}
