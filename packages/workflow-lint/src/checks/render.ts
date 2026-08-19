import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'

/** The closed renderer set (02); unknown values are a lint error, not a fallback. */
const RENDERERS = new Set(['transcript', 'chart', 'images', 'code', 'island'])

export function checkRender(def: Definition): Finding[] {
  const findings: Finding[] = []

  function checkDef(decl: unknown, pointer: string): void {
    if (decl === null || typeof decl !== 'object') return
    const d = decl as Record<string, unknown>
    if (typeof d.render === 'string' && !RENDERERS.has(d.render)) {
      findings.push({
        rule: 'unknown-render',
        severity: 'error',
        message: `unknown render \`${d.render}\` — renderers are: transcript, chart, images, code, island (02)`,
        path: `${pointer}/render`,
      })
    }
    if (d.render === 'island' && typeof d.src !== 'string') {
      findings.push({
        rule: 'island-render-src',
        severity: 'error',
        message: 'render: island needs a `src` pointing at the island HTML (02)',
        path: pointer,
      })
    }
  }

  function checkMap(map: Record<string, unknown> | undefined, pointer: string): void {
    for (const [name, decl] of Object.entries(map ?? {})) checkDef(decl, `${pointer}/${name}`)
  }

  checkMap(def.inputs, '/on/manual/inputs')
  for (const job of Object.values(def.jobs)) {
    for (const step of job.steps) {
      const base = `/jobs/${job.id}/steps/${step.index}`
      checkMap(step.raw.outputs, `${base}/outputs`)
      if (step.uses === 'form') checkMap(step.raw.with?.fields, `${base}/with/fields`)
    }
    checkMap(job.outputs, `/jobs/${job.id}/outputs`)
  }
  checkMap(def.outputs, '/outputs')

  return findings
}
