/**
 * Pure helpers for share-link URLs and reuse decisions. No backend coupling.
 */
import type { ShareLink } from '../store/handoffApi'

/**
 * Copy URL for a share link. With `nodeId` → a raw one-request file-direct URL
 * that lands the recipient on the file (`/r/{id}?token=`); without → the folder
 * `/s/{token}` URL (`link.url`). The token is always the existing folder-scoped token.
 */
export function shareLinkCopyUrl(
  origin: string,
  link: { token: string; url: string },
  nodeId?: string,
): string {
  return nodeId ? `${origin}/r/${nodeId}?token=${link.token}` : `${origin}${link.url}`
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
