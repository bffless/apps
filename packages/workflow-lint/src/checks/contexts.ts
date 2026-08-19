import { KNOWN_FUNCTIONS, STATUS_FUNCTIONS } from '../expressions/functions.js'
import type { Finding } from '../findings.js'
import { allowedRoots } from '../model/contexts.js'
import type { Definition } from '../model/definition.js'
import type { ExprSite } from '../model/slots.js'
import { collectRefs } from './refs.js'

const ALL_CONTEXTS = new Set([
  'inputs',
  'needs',
  'steps',
  'matrix',
  'strategy',
  'response',
  'error',
  'step',
  'run',
  'impl',
  'jobs',
])

const KNOWN = new Set<string>(KNOWN_FUNCTIONS)
const STATUS = new Set<string>(STATUS_FUNCTIONS)

export function checkContexts(def: Definition, sites: ExprSite[]): Finding[] {
  const findings: Finding[] = []
  for (const site of sites) {
    if (!site.expr) continue
    const job = site.slot.jobId ? def.jobs[site.slot.jobId] : undefined
    const allowed = allowedRoots(site.slot, job)
    const { refs, calls } = collectRefs(site.expr)

    for (const ref of refs) {
      if (allowed.has(ref.root)) continue
      if (ALL_CONTEXTS.has(ref.root)) {
        const detail =
          ref.root === 'response'
            ? "`response` is only readable in a pipeline step's poll, retry, outputs, summary and annotations"
            : ref.root === 'matrix' || ref.root === 'strategy'
              ? `\`${ref.root}\` is only available inside a job with strategy.matrix`
              : ref.root === 'jobs'
                ? '`jobs` is only available in top-level outputs'
                : ref.root === 'steps' || ref.root === 'needs'
                  ? `\`${ref.root}\` is not available in ${site.slot.where === 'top-output' ? 'top-level outputs (use jobs.<id>.outputs)' : `a ${site.slot.where} slot`}`
                  : `\`${ref.root}\` is not available in a ${site.slot.where} slot`
        findings.push({
          rule: 'context-position',
          severity: 'error',
          message: `context \`${ref.root}\` is not available here — ${detail}`,
          path: site.pointer,
        })
      } else {
        findings.push({
          rule: 'unknown-context',
          severity: 'error',
          message: `unknown context \`${ref.root}\` — contexts are: inputs, needs, steps, matrix, strategy, response, error, step, run, impl, jobs`,
          path: site.pointer,
        })
      }
    }

    for (const call of calls) {
      const name = call.callee.toLowerCase()
      if (!KNOWN.has(name)) {
        findings.push({
          rule: 'unknown-function',
          severity: 'error',
          message: `unknown function \`${call.callee}()\` — functions are: contains, startsWith, endsWith, format, join, toJSON, fromJSON, length, pluck, success, failure, always, cancelled`,
          path: site.pointer,
        })
      } else if (STATUS.has(name) && !site.slot.isIf) {
        findings.push({
          rule: 'status-fn-position',
          severity: 'error',
          message: `\`${call.callee}()\` is only valid in an \`if\` condition (01)`,
          path: site.pointer,
        })
      }
    }
  }
  return findings
}
