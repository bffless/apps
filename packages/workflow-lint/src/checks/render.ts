import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'
import { walkDecls } from './decls.js'

/** The closed renderer set (02); unknown values are a lint error, not a fallback. */
const RENDERERS = new Set(['transcript', 'chart', 'images', 'code', 'island'])

export function checkRender(def: Definition): Finding[] {
  const findings: Finding[] = []

  walkDecls(def, (decl, pointer) => {
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
    if (d.render === 'chart' || d.render === 'code') {
      const mapping = (d.mapping ?? {}) as Record<string, unknown>
      const missing =
        d.render === 'chart'
          ? typeof mapping.x !== 'string' || typeof mapping.y !== 'string'
          : typeof mapping.language !== 'string'
      if (missing) {
        const need = d.render === 'chart' ? '`mapping.x` and `mapping.y`' : '`mapping.language`'
        findings.push({
          rule: 'render-mapping',
          severity: 'warning',
          message: `render: ${d.render} needs ${need} (02)`,
          path: `${pointer}/mapping`,
        })
      }
    }
  })

  return findings
}
