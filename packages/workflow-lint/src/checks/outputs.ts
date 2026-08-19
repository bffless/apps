import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'
import { isSingleExpression, scanTemplates } from '../expressions/template.js'
import { collectRefs } from './refs.js'

/** Roots whose direct reference keeps its declared type in a job output (01). */
const DIRECT_ROOTS = new Set(['steps', 'inputs', 'matrix'])

export function checkOutputs(def: Definition): Finding[] {
  const findings: Finding[] = []

  for (const job of Object.values(def.jobs)) {
    for (const step of job.steps) {
      if (step.uses === 'pipeline' && step.raw.outputs == null) {
        findings.push({
          rule: 'outputs-omitted',
          severity: 'notice',
          message:
            `pipeline step \`${step.id}\` declares no outputs — it exposes only outputs.response (json); ` +
            'discouraged in shipped workflows (03)',
          path: `/jobs/${job.id}/steps/${step.index}`,
        })
      }
    }

    for (const [name, decl] of Object.entries(job.outputs)) {
      if (typeof decl !== 'string') continue // object form declares its type
      if (!isSingleExpression(decl)) continue // interpolation is a string; fine
      const expr = scanTemplates(decl)[0]?.expr
      if (!expr) continue
      const direct =
        (expr.kind === 'member' || expr.kind === 'index' || expr.kind === 'ident') &&
        (() => {
          const { refs, calls } = collectRefs(expr)
          return (
            calls.length === 0 &&
            refs.length === 1 &&
            refs[0]!.node === expr &&
            DIRECT_ROOTS.has(refs[0]!.root) &&
            refs[0]!.path.every((seg) => seg !== null)
          )
        })()
      if (!direct) {
        findings.push({
          rule: 'untyped-job-output',
          severity: 'notice',
          message:
            `job output \`${name}\` is a computed expression, so its type is json — ` +
            'declare the object form { type: …, value: "${{ … }}" } to keep the real type (01)',
          path: `/jobs/${job.id}/outputs/${name}`,
        })
      }
    }
  }

  return findings
}
