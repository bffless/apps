/**
 * The extension ↔ media-type map the driver uses when a file's own metadata
 * says nothing: a local path has only its extension; a downloaded response
 * may answer `application/octet-stream` or no `Content-Type` at all.
 *
 * `.mov` is here because Capture's `recording` input is usually a macOS
 * screen recording, and the harness's own kickoff form would have sent
 * `video/quicktime` for it.
 */
const MIME: Record<string, string> = {
  '.bin': 'application/octet-stream',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
}

/** The extension `extensionFor` answers when several share one media type. */
const CANONICAL: Record<string, string> = {
  'image/jpeg': '.jpg',
  'text/html': '.html',
  'application/yaml': '.yaml',
}

function extname(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

/** The media type for a path's extension; `application/octet-stream` when unknown. */
export function contentTypeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** The dotted extension for a media type (parameters and case ignored); `''` when unknown. */
export function extensionFor(contentType: string): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (type === '') return ''
  if (CANONICAL[type]) return CANONICAL[type]
  for (const [ext, mime] of Object.entries(MIME)) if (mime === type) return ext
  return ''
}
