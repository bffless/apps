import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'

/**
 * `src` extensions for the interactive kinds (Decision 17), plus the one
 * reserved `with` key that would collide with an island's tool-input
 * envelope. `island`/`script` steps go through the first pass below; a
 * `render: island` declaration (input, step output, form field, job/run
 * output) is checked wherever `checkRender` already walks — a missing `src`
 * is `island-render-src`'s job, not this rule's, so we only look at the
 * extension when `src` is present as a string.
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

  function checkDecl(decl: unknown, pointer: string): void {
    if (decl === null || typeof decl !== 'object') return
    const d = decl as Record<string, unknown>
    if (d.render === 'island') checkExt(d.src, `${pointer}/src`, 'island-src-ext', ['.html'])
  }

  function checkMap(map: Record<string, unknown> | undefined, pointer: string): void {
    for (const [name, decl] of Object.entries(map ?? {})) checkDecl(decl, `${pointer}/${name}`)
  }

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
      checkMap(step.raw.outputs, `${base}/outputs`)
      if (step.uses === 'form') checkMap(step.raw.with?.fields, `${base}/with/fields`)
    }
    checkMap(job.outputs, `/jobs/${job.id}/outputs`)
  }
  checkMap(def.inputs, '/on/manual/inputs')
  checkMap(def.outputs, '/outputs')

  return findings
}
