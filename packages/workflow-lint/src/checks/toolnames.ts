import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'

/**
 * Tool names are dot-canonical, slash-tolerant (Decision 1): a pipeline
 * step's `path` becomes its tool name by turning `/` into `.`; resolving a
 * name back turns every `.` into `/` unless the name already contains a
 * `/`. A path that itself contains a `.` therefore only round-trips through
 * its slash form — worth a notice, but only once a workflow actually has an
 * island step to call it.
 */
export function checkToolNames(def: Definition): Finding[] {
  const hasIsland = Object.values(def.jobs).some((job) => job.steps.some((s) => s.uses === 'island'))
  if (!hasIsland) return []

  const findings: Finding[] = []
  for (const job of Object.values(def.jobs)) {
    for (const step of job.steps) {
      if (step.uses !== 'pipeline') continue
      const path = step.raw.with?.path
      if (typeof path !== 'string' || !path.includes('.')) continue
      findings.push({
        rule: 'tool-name-dot',
        severity: 'notice',
        message:
          `pipeline path \`${path}\` contains \`.\` — dot-canonical tool naming would misresolve it, so an ` +
          'island can only call this pipeline by its slash-form tool name (Decision 1)',
        path: `/jobs/${job.id}/steps/${step.index}/with/path`,
      })
    }
  }
  return findings
}
