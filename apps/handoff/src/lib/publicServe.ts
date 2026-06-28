/**
 * Pure gate for the public (no-auth) reverse-proxy serve path
 * (`GET /api/public/content/*`).
 *
 * Handoff content is private by default. A file node may be served at a stable,
 * anonymous URL ONLY when it is explicitly flagged `public` AND it is small
 * enough to stream through the file server (every public read reverse-proxies
 * the bytes from the private bucket through the app, so large assets stay on the
 * authenticated/presigned path — see ADR-0001).
 *
 * This mirrors the embedded `publicGate` step in `handoff.proxy-rules.json`
 * verbatim so the guard test exercises the real decision. Never throws.
 */

/** Reverse-proxying through the app is only acceptable for small images. */
export const PUBLIC_SERVE_MAX_BYTES = 10 * 1024 * 1024 // 10 MB

export interface PublicServeNode {
  nodeType?: unknown
  public?: unknown
  size?: unknown
}

export function evaluatePublicServe(input: {
  /** The node resolved by storage_path, or null/undefined when none matched. */
  node: PublicServeNode | null | undefined
  /** Override the size ceiling (defaults to PUBLIC_SERVE_MAX_BYTES). */
  maxBytes?: number
}): { allow: boolean; deny: boolean } {
  const { node } = input
  const maxBytes = input.maxBytes ?? PUBLIC_SERVE_MAX_BYTES

  if (!node || typeof node !== 'object') return { allow: false, deny: true }

  // Only files are servable. Records default to 'file' when nodeType is absent.
  const isFile = node.nodeType === 'file' || node.nodeType == null
  // Opt-in only: the flag must be explicitly true (boolean or the string the
  // data layer may round-trip).
  const isPublic = node.public === true || node.public === 'true'
  // Size must be known and within the ceiling — an unknown size is denied
  // rather than risk streaming a large object through the app.
  const sizeNum = node.size == null ? NaN : Number(node.size)
  const withinLimit = Number.isFinite(sizeNum) ? sizeNum <= maxBytes : false

  const allow = isFile && isPublic && withinLimit
  return { allow, deny: !allow }
}
