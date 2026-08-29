import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'
import { walkDecls } from './decls.js'

/**
 * `images` (02) is the `markdown` type's one extra key: a `{ [src]: path }`
 * map the harness's markdown viewer rewrites `![alt](src)` through. On any
 * other type nothing reads it, so it is a mistake worth stopping — the author
 * meant `type: markdown`, or put the key on the wrong declaration.
 */
export function checkImages(def: Definition): Finding[] {
  const findings: Finding[] = []

  walkDecls(def, (decl, pointer) => {
    if (decl === null || typeof decl !== 'object') return
    const d = decl as Record<string, unknown>
    if (d.images === undefined) return
    if (d.type !== 'markdown') {
      findings.push({
        rule: 'markdown-images',
        severity: 'error',
        message: `\`images\` is only read on a \`markdown\` output (02); this declaration is \`${typeof d.type === 'string' ? d.type : 'untyped'}\``,
        path: `${pointer}/images`,
      })
      return
    }
    const isExpr = typeof d.images === 'string'
    const isMap = d.images !== null && typeof d.images === 'object' && !Array.isArray(d.images)
    if (!isExpr && !isMap) {
      findings.push({
        rule: 'markdown-images',
        severity: 'error',
        message: '`images` must be an expression or a `{ [src]: path }` map (02)',
        path: `${pointer}/images`,
      })
    }
  })

  return findings
}
