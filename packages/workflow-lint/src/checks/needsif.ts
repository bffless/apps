import { STATUS_FUNCTIONS } from '../expressions/functions.js'
import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'
import type { ExprSite } from '../model/slots.js'
import { collectRefs } from './refs.js'

const STATUS = new Set<string>(STATUS_FUNCTIONS)

function list(ids: string[]): string {
  const quoted = ids.map((id) => `\`${id}\``)
  if (quoted.length <= 1) return quoted.join('')
  return `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`
}

/**
 * A job with `needs` whose `if` names no status function (01).
 *
 * `if` on a job defaults to `success()` — but only when it is absent. An
 * explicit `if` replaces the default wholesale (GitHub semantics; the harness's
 * `evalIf` does the same), so `if: ${{ inputs.blog }}` on a job that needs
 * `per-video` runs when `per-video` failed. That is how the Studio port's
 * `blog` / `cover` jobs ran on a failed `per-video` (apps#427 §4).
 *
 * Reading `needs.<job>.result` counts as an explicit gate: the author has
 * looked at the dependency's outcome, whatever they decided to do with it.
 * A span that failed to parse is already an `expr-parse` error and is not
 * second-guessed here.
 */
export function checkNeedsIf(def: Definition, sites: ExprSite[]): Finding[] {
  const findings: Finding[] = []
  for (const job of Object.values(def.jobs)) {
    if (job.needs.length === 0 || typeof job.if !== 'string') continue
    const ifSites = sites.filter((s) => s.slot.where === 'job-if' && s.slot.jobId === job.id)
    if (ifSites.length === 0 || ifSites.some((s) => !s.expr)) continue

    const gated = ifSites.some((s) => {
      const { refs, calls } = collectRefs(s.expr!)
      return (
        calls.some((c) => STATUS.has(c.callee.toLowerCase())) ||
        refs.some((r) => r.root === 'needs' && r.path[1] === 'result')
      )
    })
    if (gated) continue

    findings.push({
      rule: 'needs-if-status',
      severity: 'warning',
      message: `job \`${job.id}\` has \`needs\` but its \`if\` names no status function — an explicit \`if\` replaces the default \`success()\`, so it runs even when ${list(job.needs)} failed (01)`,
      path: ifSites[0]!.pointer,
      hint: `write \`if: \${{ success() && <condition> }}\` to keep the default gate, or \`always()\` / \`failure()\` if running after a failure is the intent`,
    })
  }
  return findings
}
