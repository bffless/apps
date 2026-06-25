/**
 * ManageAccessPanel — embedded panel for owners to manage grants on a folder.
 *
 * Features:
 * - Lists current grants with email + level badge + Revoke button
 * - Add row: debounced directory autocomplete (300ms, min 2 chars) → dropdown → click → grant View
 * - Share links section: create link with optional expiry, copy URL, list, revoke
 * - Pending/loading states per action
 * - 403 error handling
 */

import { useState, useEffect, useRef } from 'react'
import {
  useGetGrantsQuery,
  useAddGrantMutation,
  useRevokeGrantMutation,
  useSearchDirectoryQuery,
  useMintShareLinkMutation,
  useListShareLinksQuery,
  useRevokeShareLinkMutation,
} from '../store/handoffApi'
import type { ShareLink } from '../store/handoffApi'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ManageAccessPanelProps {
  folderId: string
  onClose: () => void
}

// ---------------------------------------------------------------------------
// Level badge
// ---------------------------------------------------------------------------

function LevelBadge({ level }: { level: 'view' | 'edit' }) {
  const cls =
    level === 'edit'
      ? 'rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700'
      : 'rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700'
  return <span className={cls}>{level === 'edit' ? 'Can edit' : 'Can view'}</span>
}

// ---------------------------------------------------------------------------
// DirectorySearch — debounced autocomplete
// ---------------------------------------------------------------------------

interface DirectorySearchProps {
  onSelect: (user: { id: string; email: string }) => void
  disabled: boolean
}

function DirectorySearch({ onSelect, disabled }: DirectorySearchProps) {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  // Whether the user has manually dismissed the dropdown for the current query
  const [dismissed, setDismissed] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query)
      // Changing the query resets the dismissed flag
      setDismissed(false)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const shouldSearch = debouncedQuery.length >= 2
  // Dropdown is open when search is active and not dismissed
  const open = shouldSearch && !dismissed

  const { data, isFetching } = useSearchDirectoryQuery(
    { search: debouncedQuery },
    { skip: !shouldSearch },
  )

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDismissed(true)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function handleSelect(user: { id: string; email: string }) {
    onSelect(user)
    setQuery('')
    setDebouncedQuery('')
    setDismissed(true)
  }

  const users = data?.users ?? []

  return (
    <div ref={containerRef} className="relative flex-1">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setDismissed(false)}
        disabled={disabled}
        placeholder="Search by email…"
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none disabled:opacity-50"
      />
      {isFetching && (
        <div className="absolute right-3 top-2.5">
          <svg className="h-4 w-4 animate-spin text-gray-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        </div>
      )}
      {open && users.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {users.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm text-gray-800 hover:bg-gray-50"
                onMouseDown={(e) => {
                  e.preventDefault() // prevent blur before click
                  handleSelect(u)
                }}
              >
                {u.email}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && !isFetching && shouldSearch && users.length === 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-400 shadow-lg">
          No users found
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ShareLinksSection — create, list, copy, revoke
// ---------------------------------------------------------------------------

const EXPIRY_OPTIONS: { label: string; ms: number | undefined }[] = [
  { label: 'No expiry', ms: undefined },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
]

interface ShareLinksSectionProps {
  folderId: string
}

function ShareLinksSection({ folderId }: ShareLinksSectionProps) {
  const { data: links, isLoading: loadingLinks } = useListShareLinksQuery({ folderId })
  const [mintShareLink, { isLoading: minting }] = useMintShareLinkMutation()
  const [revokeShareLink, { isLoading: revoking }] = useRevokeShareLinkMutation()

  const [expiryIdx, setExpiryIdx] = useState(0)
  const [mintError, setMintError] = useState<string | null>(null)
  const [newLink, setNewLink] = useState<ShareLink | null>(null)
  const [copied, setCopied] = useState(false)
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

  function handleCopy(url: string) {
    const fullUrl = `${window.location.origin}${url}`
    void navigator.clipboard.writeText(fullUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
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
    <div className="mt-5 border-t border-gray-100 pt-5">
      <p className="mb-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Share links</p>

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
              {window.location.origin}{newLink.url}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(newLink.url)}
              className="shrink-0 rounded-lg border border-green-300 bg-white px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-50"
            >
              {copied ? 'Copied!' : 'Copy'}
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
                {link.url}
              </span>
              <span className="shrink-0 text-xs text-gray-400">{formatExpiry(link)}</span>
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

// ---------------------------------------------------------------------------
// ManageAccessPanel
// ---------------------------------------------------------------------------

export function ManageAccessPanel({ folderId, onClose }: ManageAccessPanelProps) {
  const { data, isLoading, isError, error } = useGetGrantsQuery({ folderId })
  const [addGrant, { isLoading: adding }] = useAddGrantMutation()
  const [revokeGrant] = useRevokeGrantMutation()
  const [revoking, setRevoking] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)

  const grants = data?.grants ?? []

  // Derive the access error directly (no effect needed)
  const accessErrorStatus = isError ? (error as { status?: number }).status : undefined
  const accessError =
    accessErrorStatus === 403
      ? 'You do not have permission to manage access for this folder.'
      : null

  async function handleAdd(user: { id: string; email: string }) {
    setAddError(null)
    const result = await addGrant({
      folderId,
      principalId: user.id,
      principalEmail: user.email,
      level: 'view',
    })
    if ('error' in result) {
      const status = (result.error as { status?: number }).status
      if (status === 403) {
        setAddError('You do not have permission to add grants.')
      } else {
        setAddError('Failed to add access. Please try again.')
      }
    }
  }

  async function handleRevoke(principalId: string) {
    setRevoking(principalId)
    try {
      await revokeGrant({ folderId, principalId })
    } finally {
      setRevoking(null)
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Manage access</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          aria-label="Close"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      </div>

      {/* Access error */}
      {accessError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {accessError}
        </div>
      )}

      {/* Add row */}
      {!accessError && (
        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-gray-500 uppercase tracking-wide">Add person</p>
          <div className="flex items-center gap-2">
            <DirectorySearch onSelect={handleAdd} disabled={adding} />
            {adding && (
              <svg className="h-4 w-4 animate-spin shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            )}
          </div>
          {addError && (
            <p className="mt-1 text-xs text-red-600">{addError}</p>
          )}
          <p className="mt-1 text-xs text-gray-400">Search by email, then click to grant View access.</p>
        </div>
      )}

      {/* Grant list */}
      {!accessError && (
        <div>
          <p className="mb-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
            {grants.length === 0 ? 'No access granted' : `${grants.length} person${grants.length !== 1 ? 's' : ''} with access`}
          </p>

          {isLoading && (
            <div className="py-4 text-center text-sm text-gray-400">Loading…</div>
          )}

          {!isLoading && grants.length > 0 && (
            <ul className="flex flex-col gap-2">
              {grants.map((grant) => (
                <li
                  key={grant.principalId}
                  className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
                    {grant.principalEmail ?? grant.principalId}
                  </span>
                  <LevelBadge level={grant.level} />
                  <button
                    type="button"
                    disabled={revoking === grant.principalId}
                    onClick={() => handleRevoke(grant.principalId)}
                    className="shrink-0 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 hover:text-red-600 disabled:opacity-50"
                  >
                    {revoking === grant.principalId ? 'Revoking…' : 'Revoke'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!isLoading && !isError && grants.length === 0 && (
            <p className="py-2 text-sm text-gray-400">
              Only you can see this folder. Add someone above to share it.
            </p>
          )}
        </div>
      )}

      {/* Share links — owners only */}
      {!accessError && (
        <ShareLinksSection folderId={folderId} />
      )}
    </div>
  )
}
