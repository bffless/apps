/**
 * Pure helpers for share-link URLs and reuse decisions. No backend coupling.
 */
import type { ShareLink } from '../store/handoffApi'

/**
 * URL-safe slug for a filename, preserving the (last) extension — the part that
 * signals the file type. Output is pure ASCII `[a-z0-9.-]`, so it needs no
 * URL-encoding. Decorative only: never used to resolve the file.
 */
export function slugifyFilename(name: string): string {
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0
  const base = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot + 1) : ''
  const baseSlug =
    base
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'file'
  const extSlug = ext.toLowerCase().replace(/[^a-z0-9]/g, '')
  return extSlug ? `${baseSlug}.${extSlug}` : baseSlug
}

/**
 * Copy URL for a share link. With `nodeId` → a raw one-request file-direct URL
 * that lands the recipient on the file (`/r/{id}?token=`); without → the folder
 * `/s/{token}` URL (`link.url`). The token is always the existing folder-scoped token.
 *
 * When `fileName` is given, a decorative `/{slug}` segment is inserted before the
 * query (`/r/{id}/{slug}?token=`) so the file type is visible in the link. The
 * `/r/*` pipeline ignores the segment, so it's cosmetic and backward compatible.
 */
export function shareLinkCopyUrl(
  origin: string,
  link: { token: string; url: string },
  nodeId?: string,
  fileName?: string,
): string {
  if (!nodeId) return `${origin}${link.url}`
  const seg = fileName ? `/${slugifyFilename(fileName)}` : ''
  return `${origin}/r/${nodeId}${seg}?token=${link.token}`
}

/**
 * First active (non-revoked, non-expired) link, or null. Used to reuse one
 * folder token across files instead of minting a new one each copy.
 */
export function pickReusableToken(links: ShareLink[] | undefined, nowMs: number): ShareLink | null {
  if (!links) return null
  for (const l of links) {
    if (l.revoked) continue
    if (l.expiresAt != null && l.expiresAt < nowMs) continue
    return l
  }
  return null
}

/**
 * Whether a viewer arriving with `?token` should claim it: only when there is a
 * token and the user is not already authenticated (authed users have access).
 */
export function shouldClaimToken(input: { token: string | null; authenticated: boolean }): boolean {
  return !!input.token && !input.authenticated
}
