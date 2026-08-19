import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'

/** Step ids must be unique within their job (01); the schema can't see arrays. */
export function checkIds(def: Definition): Finding[] {
  const findings: Finding[] = []
  for (const job of Object.values(def.jobs)) {
    const seen = new Set<string>()
    for (const step of job.steps) {
      if (seen.has(step.id)) {
        findings.push({
          rule: 'duplicate-step-id',
          severity: 'error',
          message: `duplicate step id \`${step.id}\` in job \`${job.id}\` — step ids must be unique within their job`,
          path: `/jobs/${job.id}/steps/${step.index}/id`,
        })
      }
      seen.add(step.id)
    }
  }
  return findings
}
