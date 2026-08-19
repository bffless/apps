import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'

/**
 * 01: absolute /api/… paths are legal (that is how a workflow calls harness
 * pipelines) but the linter warns on absolute paths into another
 * implementation — the alias is unknowable statically, so anything absolute
 * that is not the harness (/api/workflow/…) gets the warning.
 */
export function checkPaths(def: Definition): Finding[] {
  const findings: Finding[] = []
  for (const job of Object.values(def.jobs)) {
    for (const step of job.steps) {
      if (step.uses !== 'pipeline') continue
      const spots: Array<[string, unknown]> = [
        [`/jobs/${job.id}/steps/${step.index}/with/path`, step.raw.with?.path],
        [`/jobs/${job.id}/steps/${step.index}/poll/path`, step.raw.poll?.path],
      ]
      for (const [pointer, value] of spots) {
        if (typeof value !== 'string') continue
        if (value.startsWith('/api/') && !value.startsWith('/api/workflow/')) {
          findings.push({
            rule: 'cross-impl-path',
            severity: 'warning',
            message:
              `absolute path \`${value}\` into another implementation — prefer a relative path ` +
              '(namespaced by alias, so previews like <alias>-pr-N keep working); /api/workflow/… (the harness) is fine (01)',
            path: pointer,
          })
        }
      }
    }
  }
  return findings
}
