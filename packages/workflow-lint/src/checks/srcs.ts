import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'
import { walkDecls } from './decls.js'

/**
 * `src` extensions for the interactive kinds (Decision 17), plus the one
 * reserved `with` key that would collide with an island's tool-input
 * envelope. `island`/`script` steps are checked directly below; a
 * `render: island` declaration (input, step output, form field, job/run
 * output) is checked via the shared `walkDecls` walker — the same site list
 * `checkRender` walks for `island-render-src`/`unknown-render`/`render-mapping`
 * — so a `src` missing entirely stays `island-render-src`'s job, not this
 * rule's: we only look at the extension when `src` is present as a string.
 */
export function checkSrcs(def: Definition): Finding[] {
  const findings: Finding[] = []

  function checkExt(
    src: unknown,
    pointer: string,
    rule: 'island-src-ext' | 'script-src-ext',
    exts: string[],
  ): void {
    if (typeof src !== 'string') return
    if (exts.some((ext) => src.endsWith(ext))) return
    findings.push({
      rule,
      severity: 'error',
      message: `\`src\` must end ${exts.map((e) => `\`${e}\``).join(' or ')} — got \`${src}\` (02)`,
      path: pointer,
    })
  }

  walkDecls(def, (decl, pointer) => {
    if (decl === null || typeof decl !== 'object') return
    const d = decl as Record<string, unknown>
    if (d.render === 'island') checkExt(d.src, `${pointer}/src`, 'island-src-ext', ['.html'])
  })

  for (const job of Object.values(def.jobs)) {
    for (const step of job.steps) {
      const base = `/jobs/${job.id}/steps/${step.index}`
      if (step.uses === 'island') {
        checkExt(step.raw.with?.src, `${base}/with/src`, 'island-src-ext', ['.html'])
        const w = step.raw.with
        if (w !== null && typeof w === 'object' && 'arguments' in w) {
          findings.push({
            rule: 'island-reserved-with',
            severity: 'error',
            message:
              '`with.arguments` is reserved — `src`, `title`, `display` are stripped from `with` before ' +
              'the rest becomes tool input, but `arguments` is not one of those and would collide with the ' +
              'tool-input envelope the island sends on `tools/call` (Decision 1, 10)',
            path: `${base}/with/arguments`,
          })
        }
      } else if (step.uses === 'script') {
        checkExt(step.raw.with?.src, `${base}/with/src`, 'script-src-ext', ['.js', '.mjs'])
      }
    }
  }

  return findings
}
