/**
 * PeopleAccess — the "who can access this folder" controls: a debounced
 * directory autocomplete to grant View, and the list of current grants with a
 * Revoke action. Rendered inside the unified ShareDialog (and reused anywhere
 * folder access is managed). Folder-level by design — grants attach to folders.
 */

import { useState, useEffect, useRef } from 'react'
import {
  useGetGrantsQuery,
  useAddGrantMutation,
  useRevokeGrantMutation,
  useSearchDirectoryQuery,
} from '../store/handoffApi'

// ---------------------------------------------------------------------------
// Level badge
// ---------------------------------------------------------------------------

function LevelBadge({ level }: { level: 'view' | 'edit' }) {
  const cls =
    level === 'edit'
      ? 'bg-edit-bg text-edit'
      : 'bg-accent-bg text-accent-700'
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {level === 'edit' ? 'Can edit' : 'Can view'}
    </span>
  )
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
  const [dismissed, setDismissed] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query)
      setDismissed(false)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const shouldSearch = debouncedQuery.length >= 2
  const open = shouldSearch && !dismissed

  const { data, isFetching } = useSearchDirectoryQuery({ search: debouncedQuery }, { skip: !shouldSearch })

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
        placeholder="Search people by email…"
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-accent-500 focus:outline-none disabled:opacity-50"
      />
      {isFetching && (
        <div className="absolute right-3 top-2.5">
          <Spinner />
        </div>
      )}
      {open && users.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-md">
          {users.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-accent-bg"
                onMouseDown={(e) => {
                  e.preventDefault()
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
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted shadow-md">
          No people found
        </div>
      )}
    </div>
  )
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin text-muted" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// PeopleAccess
// ---------------------------------------------------------------------------

export function PeopleAccess({ folderId }: { folderId: string }) {
  const { data, isLoading, isError, error } = useGetGrantsQuery({ folderId })
  const [addGrant, { isLoading: adding }] = useAddGrantMutation()
  const [revokeGrant] = useRevokeGrantMutation()
  const [revoking, setRevoking] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)

  const grants = data?.grants ?? []

  const accessErrorStatus = isError ? (error as { status?: number }).status : undefined
  const accessError =
    accessErrorStatus === 403 ? 'You do not have permission to manage access for this folder.' : null

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
      setAddError(status === 403 ? 'You do not have permission to add grants.' : 'Failed to add access. Please try again.')
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

  if (accessError) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger">
        {accessError}
      </div>
    )
  }

  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">People</p>
      <div className="mb-2 flex items-center gap-2">
        <DirectorySearch onSelect={handleAdd} disabled={adding} />
        {adding && <Spinner />}
      </div>
      {addError && <p className="mb-2 text-xs text-danger">{addError}</p>}

      {isLoading && <div className="py-3 text-center text-sm text-muted">Loading…</div>}

      {!isLoading && grants.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {grants.map((grant) => (
            <li
              key={grant.principalId}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-ink">
                {grant.principalEmail ?? grant.principalId}
              </span>
              <LevelBadge level={grant.level} />
              <button
                type="button"
                disabled={revoking === grant.principalId}
                onClick={() => handleRevoke(grant.principalId)}
                className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-danger disabled:opacity-50"
              >
                {revoking === grant.principalId ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!isLoading && !isError && grants.length === 0 && (
        <p className="rounded-lg bg-surface-2/60 px-3 py-2.5 text-sm text-muted">
          Only you can see this folder. Search above to share it with someone.
        </p>
      )}
    </div>
  )
}
