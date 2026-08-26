/**
 * The url policy, in one module: what may be written into an `href`/`src`/`data`
 * attribute (`isSafeUrl`), and what may be *fetched* from an untrusted ref
 * (`isServeUrl`).
 *
 * `isSafeUrl`'s two callers, one rule: `lib/markdown` (link and image hrefs
 * inside a summary) and `components/values/FileCard` (a `FileRef.url` out of a
 * step's outputs). Neither source is trusted — a run row's JSON is writable by
 * any authenticated member, and a summary is markdown a workflow author typed —
 * so the answer must not depend on which sink asks. `isServeUrl` answers the
 * stricter question its two fetching callers ask; see below.
 */
import { SERVE_PREFIX } from './coerce'

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

/**
 * May this url be trusted as a media *sink* — an `<img>`/`<video>`/`<audio>`
 * `src` a renderer builds itself, rather than the writer-supplied `FileRef.url`
 * FileCard's own `isSafeUrl` gate covers? Root-relative (already excludes
 * protocol-relative, checked first) or same-origin absolute http(s): a
 * cross-origin `src` would leak the member's session cookie to a third party
 * the same way an untrusted fetch would, so "safe scheme" is not enough here —
 * unlike `isSafeUrl`, off-origin is refused even for `http(s)`. `false` when
 * there is no `location` (a non-browser render, e.g. SSR or a headless test
 * harness with no jsdom `location` polyfill) — nothing to compare the origin
 * against, so nothing is trusted.
 */
export function isSameOriginUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  const normalized = normalizeForSchemeCheck(url)
  if (PROTOCOL_RELATIVE.test(normalized)) return false
  if (normalized.startsWith('/')) return true
  if (!/^https?:/i.test(normalized)) return false
  const origin = globalThis.location?.origin
  if (origin === undefined) return false
  try {
    return new URL(normalized).origin === origin
  } catch {
    return false
  }
}

/**
 * 02: the Download action is always `url + (?|&) + download=1`. Lives beside
 * the allow-list because its two callers — `FileCard` (a `file` output's own
 * ref) and `ValueView`'s "payload unavailable" chip (an offloaded `{"$file"}`
 * payload whose bytes could not be read) — must build the same href from the
 * same, already-`isSafeUrl`-checked url.
 */
export function downloadHref(url: string): string {
  return url + (url.includes('?') ? '&' : '?') + 'download=1'
}

/**
 * The base a serve url is resolved against. Synthetic on purpose: every url
 * that reaches the check below is already known to be rooted, so the origin
 * cannot matter, and pinning it keeps the function usable (and testable)
 * wherever there is no `location`.
 */
const CHECK_BASE = 'https://harness.invalid'

/**
 * May the harness *fetch* this url with the member's session cookie?
 *
 * Two callers, both handed a `FileRef.url` off a run row any authenticated
 * member can write: `scripts/ScriptHost`'s `ctx.files.fetch` relay and
 * `lib/payloadFetch`'s `{"$file"}` read. Same-origin is **not** enough — a
 * same-origin path reaches the run API, another implementation's bundle, or
 * any other cookie-gated route — so the gate is the file-serve route itself
 * (`SERVE_PREFIX`, the prefix `coerce.ts`'s `fileUrl` builds). That still lets
 * a run read `inputs/` uploads and other runs' files, which D14 allows.
 *
 * Three ways a url lies about where it points, all closed here:
 * `//host` / `/\host` (protocol-relative — off-site with the scheme left out,
 * and WHATWG reads `\` as `/`), whitespace padding (stripped before a scheme
 * or a second slash is ever read, exactly as `isSafeUrl` does), and `..` /
 * `%2e%2e` segments that climb out of the prefix (resolved away by `new URL`).
 */
export function isServeUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  const normalized = normalizeForSchemeCheck(url)
  // Rooted, and its second character is neither `/` nor `\`.
  if (normalized[0] !== '/' || PROTOCOL_RELATIVE.test(normalized)) return false

  let resolved: URL
  try {
    resolved = new URL(normalized, CHECK_BASE)
  } catch {
    return false
  }
  return resolved.origin === CHECK_BASE && resolved.pathname.startsWith(SERVE_PREFIX)
}
