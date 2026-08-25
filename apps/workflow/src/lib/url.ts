/**
 * The one allow-list for every url the harness is about to write into an
 * `href`/`src`/`data` attribute.
 *
 * Two callers, one rule: `lib/markdown` (link and image hrefs inside a
 * summary) and `components/values/FileCard` (a `FileRef.url` out of a step's
 * outputs). Neither source is trusted — a run row's JSON is writable by any
 * authenticated member, and a summary is markdown a workflow author typed — so
 * the answer must not depend on which sink asks.
 */

/**
 * WHATWG URL parsing strips ASCII tab/newline/CR from anywhere in the string
 * (not just the ends) before a scheme is ever read — `java\tscript:` parses
 * as `javascript:`. Also trims the usual leading/trailing whitespace/control
 * characters, so both are gone before the scheme allow-list check below.
 */
export function normalizeForSchemeCheck(url: string): string {
  let out = ''
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i)
    if (code > 32) out += url[i]
  }
  return out
}

// An HTML entity (numeric or named, e.g. `&#58;`, `&#x3a;`, `&colon;`) inside
// a url can decode to a colon *after* this string is written into the DOM,
// smuggling a `javascript:` scheme past a check that only ever sees the raw,
// still-encoded token text. `&amp;` is excluded — it's the ordinary way to
// write a literal `&` in a query string and decodes to nothing dangerous.
const SUSPICIOUS_ENTITY = /&(?!amp;)(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i

const SAFE_SCHEME = /^(https?:|mailto:)/i
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * `//host/…` is an *absolute* url in disguise — it inherits the page's scheme
 * and goes off-site — and WHATWG reads `\` as `/` for http(s), so `/\host` is
 * the same thing. Checked after `normalizeForSchemeCheck`, which has already
 * stripped the whitespace an attacker would pad the second slash with.
 */
const PROTOCOL_RELATIVE = /^[/\\]{2}/

/**
 * Allow-list: `http:`/`https:`/`mailto:`, and anything with no scheme at all
 * (root-relative `/…`, `./`/`../`-relative, a bare path, or a `#fragment`).
 * Everything else — `javascript:`, `data:`, `vbscript:`, a protocol-relative
 * `//host`, and any url carrying an HTML entity — is unsafe, and the caller
 * renders text instead of a sink.
 */
export function isSafeUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string') return false
  if (SUSPICIOUS_ENTITY.test(rawUrl)) return false
  const url = normalizeForSchemeCheck(rawUrl)
  if (PROTOCOL_RELATIVE.test(url)) return false
  if (SAFE_SCHEME.test(url)) return true
  if (/^[#/.]/.test(url)) return true
  return !HAS_SCHEME.test(url)
}
