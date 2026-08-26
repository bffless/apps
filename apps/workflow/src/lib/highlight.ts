/**
 * `render: code` (02): highlighting via `highlight.js`'s core build, with a
 * fixed, explicitly-registered language set — never `hljs.highlightAuto`,
 * which would guess at a language the definition never declared. Registering
 * through `lib/core` (not the full `highlight.js` bundle) keeps every
 * language the app doesn't use out of the bundle.
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('python', python)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('markdown', markdown)

/**
 * Highlight `source` as `language` when it's one of the registered set.
 * `html` is `null` (not a best-effort guess) when the language is missing or
 * unregistered — the caller falls back to escaped plain text in that case.
 */
export function highlightCode(
  source: string,
  language: string | undefined,
): { html: string | null; language: string | null } {
  if (typeof language !== 'string' || !hljs.getLanguage(language)) {
    return { html: null, language: null }
  }
  const { value } = hljs.highlight(source, { language })
  return { html: value, language }
}
