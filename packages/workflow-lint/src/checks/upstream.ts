import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'
import { stepOutputNames } from '../model/definition.js'
import type { ExprSite } from '../model/slots.js'
import { collectRefs } from './refs.js'

/**
 * Slots where a step may reference itself (01: own summary/annotations, and a
 * `markdown` output's `images` map — all three are read after the step is done).
 */
const SELF_OK = new Set(['summary', 'annotation-if', 'annotation-message', 'step-output-images'])

export function checkUpstream(def: Definition, sites: ExprSite[]): Finding[] {
  const findings: Finding[] = []

  for (const site of sites) {
    if (!site.expr) continue
    const { refs } = collectRefs(site.expr)
    const job = site.slot.jobId ? def.jobs[site.slot.jobId] : undefined

    for (const ref of refs) {
      if (ref.root === 'steps' && job) {
        const [stepId, second, outputName] = ref.path
        if (stepId == null) continue // dynamic segment — not statically checkable
        const target = job.steps.find((s) => s.id === stepId)
        if (!target) {
          findings.push({
            rule: 'upstream-reference',
            severity: 'error',
            message: `\`steps.${stepId}\` — job \`${job.id}\` has no step \`${stepId}\``,
            path: site.pointer,
          })
          continue
        }
        // Job outputs come after every step; step slots compare indexes.
        const fromIndex = site.slot.stepIndex ?? Number.POSITIVE_INFINITY
        if (target.index > fromIndex) {
          findings.push({
            rule: 'upstream-reference',
            severity: 'error',
            message: `\`steps.${stepId}\` references a later step of job \`${job.id}\` — steps may only read earlier steps (01)`,
            path: site.pointer,
          })
          continue
        }
        if (target.index === fromIndex && !SELF_OK.has(site.slot.where)) {
          findings.push({
            rule: 'upstream-reference',
            severity: 'error',
            message: `step \`${stepId}\` may not reference itself here — self-reference is only allowed in its own summary/annotations, or a markdown output's \`images\` map (01/02)`,
            path: site.pointer,
          })
          continue
        }
        if (second === 'outputs' && typeof outputName === 'string') {
          const names = stepOutputNames(target)
          if (names && !names.includes(outputName)) {
            findings.push({
              rule: 'unknown-output',
              severity: 'warning',
              message: `step \`${stepId}\` declares no output \`${outputName}\` (has: ${names.join(', ') || 'none'})`,
              path: site.pointer,
            })
          }
        }
      }

      if (ref.root === 'needs' && job) {
        const [needId, second, outputName] = ref.path
        if (needId == null) continue
        if (!job.needs.includes(needId)) {
          const exists = needId in def.jobs
          findings.push({
            rule: 'upstream-reference',
            severity: 'error',
            message: exists
              ? `\`needs.${needId}\` — job \`${job.id}\` does not list \`${needId}\` in its needs (01)`
              : `\`needs.${needId}\` — there is no job \`${needId}\``,
            path: site.pointer,
          })
          continue
        }
        const target = def.jobs[needId]
        if (target && second === 'outputs' && typeof outputName === 'string') {
          if (!(outputName in target.outputs)) {
            findings.push({
              rule: 'unknown-output',
              severity: 'warning',
              message: `job \`${needId}\` declares no output \`${outputName}\` (has: ${Object.keys(target.outputs).join(', ') || 'none'})`,
              path: site.pointer,
            })
          }
        }
      }

      if (ref.root === 'jobs' && site.slot.where === 'top-output') {
        const [jobId, second, outputName] = ref.path
        if (jobId == null) continue
        const target = def.jobs[jobId]
        if (!target) {
          findings.push({
            rule: 'upstream-reference',
            severity: 'error',
            message: `\`jobs.${jobId}\` — there is no job \`${jobId}\``,
            path: site.pointer,
          })
          continue
        }
        if (second === 'outputs' && typeof outputName === 'string' && !(outputName in target.outputs)) {
          findings.push({
            rule: 'unknown-output',
            severity: 'warning',
            message: `job \`${jobId}\` declares no output \`${outputName}\` (has: ${Object.keys(target.outputs).join(', ') || 'none'})`,
            path: site.pointer,
          })
        }
      }
    }
  }

  return findings
}
