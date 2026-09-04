/**
 * The url policy, in one module: three gates for three different questions,
 * from loosest to strictest.
 *
 * `isSafeUrl` — may this url be written into an `href`/`src`/`data` attribute
 * at all? Its callers: `lib/markdown` (link and image hrefs inside a
 * summary), `components/values/FileCard`'s Download link (a `FileRef.url` out
 * of a step's outputs, kept as a link even when the ref fails the stricter
 * media-sink gate below — 02: "always a Download action"), and
 * `islands/IslandHost`'s `ui/open-link` (navigation the member's own click
 * drives, not a byte sink the harness reads on their behalf — the plain
 * allow-list is the right question there). Neither a run row nor a summary is
 * trusted — a run row's JSON is writable by any authenticated member, and a
 * summary is markdown a workflow author typed — so the answer must not depend
 * on which of these callers asks.
 *
 * `isSameOriginUrl` — the stricter question a media *sink* a renderer builds
 * itself must ask: `FileCard`'s `<video>`/`<audio>`/`<img>`/`<object data>`
 * player, and `ImagesView`'s grid `<img>`. A cross-origin `http(s)` url would
 * leak the member's session cookie to a third party the same way an untrusted
 * fetch would, so "safe scheme" is not enough here even though it is for a
 * plain link.
 *
 * `isServeUrl` — the strictest question, for a *fetch* the harness makes on
 * the member's behalf with their cookie attached: `scripts/ScriptHost`'s
 * `ctx.files.fetch` relay and `lib/payloadFetch`'s `{"$file"}` read.
 * Same-origin is not enough either — a same-origin path can reach the run API
 * or another implementation's bundle — so this one is scoped to the
 * file-serve route itself; see its own doc comment below.
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
 * 02: the Download action is always `url + (?|&) + download=1` — except a url
 * this page presigned itself: a signed GET's signature covers its exact query
 * string, so appending `download=1` would invalidate it. `signedUrls.has`
 * below is that one exception, and it's why this function must live after
 * that registry.
 */
export function downloadHref(url: string): string {
  if (signedUrls.has(url)) return url
  return url + (url.includes('?') ? '&' : '?') + 'download=1'
}

/**
 * Spec 10 D6: inside an agent host, a File-ref's ordinary `url` (same-origin
 * relative to the harness page) resolves against the *sandbox's* origin and
 * carries no session cookie — so `isSameOriginUrl` alone can never admit it
 * there, D6's reason for signing form previews before the step view renders
 * them (`step-view/deps.ts`'s `signFormPreviews`). A url this page minted for
 * itself through `workflow.sign` is the one kind of absolute, off-origin url
 * a renderer may still load — never a url a row handed us; nothing here
 * widens `isSameOriginUrl` itself. Always empty on the harness page, which
 * never calls `trustSignedUrl`.
 */
const signedUrls = new Set<string>()

/** Registers a url this page presigned itself as loadable — see `isLoadableUrl`. */
export function trustSignedUrl(url: string): void {
  signedUrls.add(url)
}

/**
 * `isSameOriginUrl`, plus a url the page presigned itself (D6). The media-sink
 * gate every renderer that builds its own `<img>`/`<video>`/`<audio>` `src`
 * should use in place of `isSameOriginUrl` — `TilePicker`'s `TilePreview`,
 * `FileCard`'s player, `ImagesView`'s grid — so a form's File-ref previews
 * still load once `signFormPreviews` has signed them, without loosening what
 * an unsigned, writer-supplied url is trusted for.
 */
export function isLoadableUrl(url: unknown): url is string {
  return isSameOriginUrl(url) || (typeof url === 'string' && signedUrls.has(url))
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
