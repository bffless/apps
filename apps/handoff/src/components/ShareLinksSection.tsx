/**
 * ShareLinksSection — create, list, copy, and revoke folder-scoped share links.
 *
 * Reused by the unified ShareDialog (and anywhere a link can be minted). Renders
 * a folder-scope clarifier so users understand a link grants View to the whole
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
  /** When true (default) renders a top divider above the section. */
  topDivider?: boolean
  /** When set, copy/display URLs are file-direct (/r/{nodeId}?token=) for this file. */
  nodeId?: string
  /** Optional file name; when set, appends a vanity slug segment to file-direct URLs. */
  fileName?: string
}

export function ShareLinksSection({ folderId, topDivider = true, nodeId, fileName }: ShareLinksSectionProps) {
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
      setMintError(
        status === 403
          ? 'You do not have permission to create share links for this folder.'
          : 'Failed to create share link. Please try again.',
      )
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
    const fullUrl = shareLinkCopyUrl(window.location.origin, link, nodeId, fileName)
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
    <div className={topDivider ? 'mt-5 border-t border-border pt-5' : ''}>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Share link</p>
      <p className="mb-3 text-xs text-muted">
        {nodeId
          ? 'Anyone with the link opens this file directly — no account needed.'
          : 'Anyone with the link can view this folder and everything in it — no account needed.'}
      </p>

      <div className="mb-3 flex items-center gap-2">
        <select
          value={expiryIdx}
          onChange={(e) => setExpiryIdx(Number(e.target.value))}
          disabled={minting}
          className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-ink focus:border-accent-500 focus:outline-none disabled:opacity-50"
        >
          {EXPIRY_OPTIONS.map((opt, i) => (
            <option key={i} value={i}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={minting}
          onClick={handleCreate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-700 disabled:opacity-50"
        >
          {minting ? (
            <>
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

      {mintError && <p className="mb-3 text-xs text-danger">{mintError}</p>}

      {newLink && !newLink.revoked && (
        <div className="mb-3 rounded-lg border border-success/30 bg-success-bg px-3 py-2">
          <p className="mb-1.5 text-xs font-medium text-success">Share link created</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded border border-success/20 bg-surface px-2 py-1 text-xs text-ink">
              {shareLinkCopyUrl(window.location.origin, newLink, nodeId, fileName)}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(newLink)}
              className="shrink-0 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:bg-surface-2"
            >
              {copiedToken === newLink.token ? 'Copied!' : 'Copy'}
            </button>
          </div>
          {newLink.expiresAt && <p className="mt-1 text-xs text-success">{formatExpiry(newLink)}</p>}
        </div>
      )}

      {loadingLinks && <div className="py-2 text-sm text-muted">Loading links…</div>}

      {!loadingLinks && activeLinks.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {activeLinks.map((link) => (
            <li key={link.token} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                {shareLinkCopyUrl(window.location.origin, link, nodeId, fileName)}
              </span>
              <span className="shrink-0 text-xs text-muted">{formatExpiry(link)}</span>
              <button
                type="button"
                onClick={() => handleCopy(link)}
                className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                {copiedToken === link.token ? 'Copied!' : 'Copy'}
              </button>
              <button
                type="button"
                disabled={revoking || revokingToken === link.token}
                onClick={() => handleRevoke(link.token)}
                className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-danger disabled:opacity-50"
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
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 opacity-50"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted line-through">
                {link.url}
              </span>
              <span className="shrink-0 text-xs text-muted">Revoked</span>
            </li>
          ))}
        </ul>
      )}

      {!loadingLinks && (links ?? []).length === 0 && (
        <p className="text-xs text-muted">No share links yet.</p>
      )}
    </div>
  )
}
