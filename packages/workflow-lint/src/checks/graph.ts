import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'

/** `needs` must reference existing jobs and form a DAG (01). */
export function checkGraph(def: Definition): Finding[] {
  const findings: Finding[] = []
  const jobIds = new Set(Object.keys(def.jobs))

  for (const job of Object.values(def.jobs)) {
    for (const need of job.needs) {
      if (!jobIds.has(need)) {
        findings.push({
          rule: 'needs-unknown',
          severity: 'error',
          message: `job \`${job.id}\` needs \`${need}\`, which is not a job in this workflow`,
          path: `/jobs/${job.id}/needs`,
        })
      }
    }
  }

  // Cycle detection: DFS with a visiting set; report each cycle once.
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const reported = new Set<string>()

  function visit(id: string): void {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(id)), id]
      const key = [...cycle].sort().join(',')
      if (!reported.has(key)) {
        reported.add(key)
        findings.push({
          rule: 'needs-cycle',
          severity: 'error',
          message: `needs cycle: ${cycle.join(' → ')} — jobs can never start`,
          path: `/jobs/${id}/needs`,
        })
      }
      return
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const need of def.jobs[id]?.needs ?? []) {
      if (jobIds.has(need)) visit(need)
    }
    stack.pop()
    state.set(id, 'done')
  }

  for (const id of jobIds) visit(id)
  return findings
}
