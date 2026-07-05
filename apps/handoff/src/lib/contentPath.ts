/**
 * Verbatim structural-storage path helpers for Handoff (structural storage,
 * Slice 1). These are the two pure seams the redesign hangs on:
 *
 *  - `contentSubPath` computes a File's verbatim content sub-path (its key under
 *    `uploads/content/`) from its owning Folder path + the file's relative path.
 *    Names are preserved byte-for-byte — spaces and unicode included — so the
 *    browser's relative reference matches the stored key exactly. Unsafe input
 *    is *rejected*, never character-sanitised (sanitising would silently break
 *    the relative refs the design exists to preserve).
 *
 *  - `viewerBase` computes the `<base href>` the Markdown/HTML viewer sets so a
 *    relative reference (`assets/logo.png`) resolves against the file's own
 *    Folder on the unified content endpoint.
 *
 * See docs/superpowers/specs/2026-07-05-structural-content-storage-design.md.
 */

/** Max total storage-key length (bytes) — S3/MinIO keys cap at ~1024. */
export const MAX_KEY_BYTES = 1024

/** Prefix every content URL/key shares under the app's serve endpoint. */
export const CONTENT_PREFIX = '/api/uploads/content/'

/** Thrown by `contentSubPath` when an input segment is structurally unsafe. */
export class UnsafeContentPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeContentPathError'
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * Compute a File's verbatim content sub-path (the key relative to
 * `uploads/content/`) from its owning Folder path and the file's relative path.
 *
 * - `folderPath` is the owning Folder's content path (`''` for a root upload).
 * - `relativePath` is the file's path within that Folder — a bare `name` for a
 *   single-file upload, or a nested `assets/logo.png` for a subtree import.
 *
 * Both are joined with `/` and every segment is validated. Names are kept
 * verbatim; the only transformations are joining and (rejecting). Unsafe input
 * — an empty / `.` / `..` segment, control characters, a leading `/`, or a total
 * key over `MAX_KEY_BYTES` — throws `UnsafeContentPathError`.
 */
export function contentSubPath(folderPath: string, relativePath: string): string {
  const left = folderPath.replace(/^\/+|\/+$/g, '')
  const right = String(relativePath)
  const joined = left ? `${left}/${right}` : right

  if (joined === '') {
    throw new UnsafeContentPathError('Empty content path.')
  }
  if (joined.startsWith('/')) {
    throw new UnsafeContentPathError('Content path must not start with "/".')
  }

  const segments = joined.split('/')
  for (const seg of segments) {
    if (seg === '') {
      throw new UnsafeContentPathError(`Empty path segment in "${joined}".`)
    }
    if (seg === '.' || seg === '..') {
      throw new UnsafeContentPathError(`Unsafe "${seg}" segment in "${joined}".`)
    }
    if (CONTROL_CHARS.test(seg)) {
      throw new UnsafeContentPathError(`Control character in path segment of "${joined}".`)
    }
  }

  if (byteLength(joined) > MAX_KEY_BYTES) {
    throw new UnsafeContentPathError(`Content path exceeds ${MAX_KEY_BYTES} bytes.`)
  }

  return joined
}

/**
 * Compute the viewer's relative-resolution base from a node's content URL.
 *
 * The base is the node's Folder — its content URL with the final segment (the
 * file name) stripped — so a relative reference in the rendered document
 * resolves to the real sibling content URL. Returns `null` when the node has no
 * content URL (e.g. a video served by presigned GET, ADR-0001).
 *
 * e.g. `/api/uploads/content/Design Docs/doc.md`
 *   → `/api/uploads/content/Design Docs/`
 */
export function viewerBase(node: { url: string | null }): string | null {
  const url = node.url
  if (!url) return null
  const slash = url.lastIndexOf('/')
  if (slash < 0) return null
  return url.slice(0, slash + 1)
}
