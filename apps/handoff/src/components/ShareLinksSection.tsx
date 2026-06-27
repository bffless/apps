/**
 * ShareLinksSection — create, list, copy, and revoke folder-scoped share links.
 *
 * Extracted from ManageAccessPanel so both the folder "Manage access" panel and
 * the viewer's Share popover reuse the same mint/list/copy/revoke UI. Renders a
 * folder-scope clarifier so users understand a link grants View to the whole
 * folder and its contents.
 */

import { useState } from 'react'
import {
  useMintShareLinkMutation,
  useListShareLinksQuery,
  useRevokeShareLinkMutation,
} from '../store/handoffApi'
import type { ShareLink } from '../store/handoffApi'
import { shareLinkCopyUrl } from '../lib/share'

const EXPIRY_OPTIONS: { label: string; ms: number | undefined }[] = [
  { label: 'No expiry', ms: undefined },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
]

export interface ShareLinksSectionProps {
  folderId: string
  /**
   * When true (default) renders a top margin, border, and padding above the
   * section — appropriate when used inside ManageAccessPanel below other UI.
   * Pass false when the component is the sole child of a popover (e.g. the
   * viewer Share popover) to avoid an orphan top border.
   */
  topDivider?: boolean
  /** When set, copy/display URLs are file-direct (/r/{nodeId}?token=) for this file. */
  nodeId?: string
}

export function ShareLinksSection({ folderId, topDivider = true, nodeId }: ShareLinksSectionProps) {
  const { data: links, isLoading: loadingLinks } = useListShareLinksQuery({ folderId })
  const [mintShareLink, { isLoading: minting }] = useMintShareLinkMutation()
  const [revokeShareLink, { isLoading: revoking }] = useRevokeShareLinkMutation()

  const [expiryIdx, setExpiryIdx] = useState(0)
  const [mintError, setMintError] = useState<string | null>(null)
  const [newLink, setNewLink] = useState<ShareLink | null>(null)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const [revokingToken, setRevokingToken] = useState<string | null>(null)

  async function handleCreate() {
    setMintError(null)
    setNewLink(null)
    const expiresMs = EXPIRY_OPTIONS[expiryIdx]?.ms
    const result = await mintShareLink({ folderId, expiresMs })
    if ('error' in result) {
      const status = (result.error as { status?: number }).status
      if (status === 403) {
        setMintError('You do not have permission to create share links for this folder.')
      } else {
        setMintError('Failed to create share link. Please try again.')
      }
    } else {
      setNewLink(result.data)
    }
  }

  async function handleRevoke(token: string) {
    setRevokingToken(token)
    try {
      await revokeShareLink({ token, folderId })
      if (newLink?.token === token) setNewLink(null)
    } finally {
      setRevokingToken(null)
    }
  }

  function handleCopy(link: ShareLink) {
    const fullUrl = shareLinkCopyUrl(window.location.origin, link, nodeId)
    void navigator.clipboard.writeText(fullUrl).then(() => {
      setCopiedToken(link.token)
      setTimeout(() => setCopiedToken((t) => (t === link.token ? null : t)), 2000)
    })
  }

  const nowMs = new Date().getTime()

  function formatExpiry(link: ShareLink): string {
    if (link.revoked) return 'Revoked'
    if (!link.expiresAt) return 'No expiry'
    if (link.expiresAt < nowMs) return 'Expired'
    const daysLeft = Math.ceil((link.expiresAt - nowMs) / (24 * 60 * 60 * 1000))
    return `Expires in ${daysLeft}d`
  }

  const activeLinks = (links ?? []).filter((l) => !l.revoked)
  const revokedLinks = (links ?? []).filter((l) => l.revoked)

  return (
    <div className={topDivider ? 'mt-5 border-t border-gray-100 pt-5' : ''}>
      <p className="mb-1 text-xs font-medium text-gray-500 uppercase tracking-wide">Share links</p>
      <p className="mb-3 text-xs text-gray-400">Anyone with the link can view this folder and everything in it.</p>

      {/* Create row */}
      <div className="mb-3 flex items-center gap-2">
        <select
          value={expiryIdx}
          onChange={(e) => setExpiryIdx(Number(e.target.value))}
          disabled={minting}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-gray-500 focus:outline-none disabled:opacity-50"
        >
          {EXPIRY_OPTIONS.map((opt, i) => (
            <option key={i} value={i}>{opt.label}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={minting}
          onClick={handleCreate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {minting ? (
            <>
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Creating…
            </>
          ) : (
            'Create link'
          )}
        </button>
      </div>

      {mintError && (
        <p className="mb-3 text-xs text-red-600">{mintError}</p>
      )}

      {/* Newly-created link — show URL + copy */}
      {newLink && !newLink.revoked && (
        <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
          <p className="mb-1.5 text-xs font-medium text-green-800">Share link created</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-xs text-gray-700 border border-green-200">
              {shareLinkCopyUrl(window.location.origin, newLink, nodeId)}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(newLink)}
              className="shrink-0 rounded-lg border border-green-300 bg-white px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-50"
            >
              {copiedToken === newLink.token ? 'Copied!' : 'Copy'}
            </button>
          </div>
          {newLink.expiresAt && (
            <p className="mt-1 text-xs text-green-700">{formatExpiry(newLink)}</p>
          )}
        </div>
      )}

      {/* Active links list */}
      {loadingLinks && (
        <div className="py-2 text-sm text-gray-400">Loading links…</div>
      )}

      {!loadingLinks && activeLinks.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {activeLinks.map((link) => (
            <li
              key={link.token}
              className="flex items-center gap-2 rounded-lg border border-gray-100 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-600">
                {shareLinkCopyUrl(window.location.origin, link, nodeId)}
              </span>
              <span className="shrink-0 text-xs text-gray-400">{formatExpiry(link)}</span>
              <button
                type="button"
                onClick={() => handleCopy(link)}
                className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-900"
              >
                {copiedToken === link.token ? 'Copied!' : 'Copy'}
              </button>
              <button
                type="button"
                disabled={revoking || revokingToken === link.token}
                onClick={() => handleRevoke(link.token)}
                className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 hover:text-red-600 disabled:opacity-50"
              >
                {revokingToken === link.token ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loadingLinks && revokedLinks.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {revokedLinks.map((link) => (
            <li
              key={link.token}
              className="flex items-center gap-2 rounded-lg border border-gray-100 px-3 py-2 opacity-50"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-400 line-through">
                {link.url}
              </span>
              <span className="shrink-0 text-xs text-gray-400">Revoked</span>
            </li>
          ))}
        </ul>
      )}

      {!loadingLinks && (links ?? []).length === 0 && (
        <p className="text-xs text-gray-400">No share links yet.</p>
      )}
    </div>
  )
}
