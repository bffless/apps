import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'
import { walkDecls } from './decls.js'

/**
 * Which types read which `format` (02). The form-control hints are the
 * `string` type's; the viewer hints (apps#450) each belong to the type whose
 * viewer reads them — `path` to `string`, `seconds` to `number` (and to
 * `json`, where every number inside is then a time), `table` and `list` to
 * `json`. On any other type nothing reads the key, so it is a mistake worth
 * stopping: the author meant a different type, or a different key.
 */
const FORMAT_TYPES: Record<string, readonly string[]> = {
  text: ['string'],
  textarea: ['string'],
  url: ['string'],
  email: ['string'],
  date: ['string'],
  datetime: ['string'],
  password: ['string'],
  path: ['string'],
  seconds: ['number', 'json'],
  table: ['json'],
  list: ['json'],
}

export function checkFormat(def: Definition): Finding[] {
  const findings: Finding[] = []

  walkDecls(def, (decl, pointer) => {
    if (decl === null || typeof decl !== 'object') return
    const d = decl as Record<string, unknown>
    if (typeof d.format !== 'string') return
    // A format outside the vocabulary is the schema's finding, not this one's.
    const types = FORMAT_TYPES[d.format]
    if (!types || typeof d.type !== 'string' || types.includes(d.type)) return
    findings.push({
      rule: 'format-type',
      severity: 'error',
      message: `\`format: ${d.format}\` is only read on a \`${types.join('` / `')}\` declaration (02); this declaration is \`${d.type}\``,
      path: `${pointer}/format`,
    })
  })

  return findings
}
