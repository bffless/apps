import type { Definition } from '../model/definition.js'

/**
 * Walks every place a typed declaration (input, step output, form field,
 * job output, top-level output) can appear in a workflow — the one site
 * list `checkRender` and `checkSrcs` both need for their `render`/`src`
 * rules. Kept in one place so a new declaration site only needs adding
 * here, not in every check that cares about declarations.
 */
export function walkDecls(def: Definition, visit: (decl: unknown, pointer: string) => void): void {
  function walkMap(map: Record<string, unknown> | undefined, pointer: string): void {
    for (const [name, decl] of Object.entries(map ?? {})) visit(decl, `${pointer}/${name}`)
  }

  walkMap(def.inputs, '/on/manual/inputs')
  for (const job of Object.values(def.jobs)) {
    for (const step of job.steps) {
      const base = `/jobs/${job.id}/steps/${step.index}`
      walkMap(step.raw.outputs, `${base}/outputs`)
      if (step.uses === 'form') walkMap(step.raw.with?.fields, `${base}/with/fields`)
    }
    walkMap(job.outputs, `/jobs/${job.id}/outputs`)
  }
  walkMap(def.outputs, '/outputs')
}
