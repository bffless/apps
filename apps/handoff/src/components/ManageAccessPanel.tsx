/**
 * PeopleAccess — the "who can access this folder" controls: a debounced
 * directory autocomplete to grant View, and the list of current grants with a
 * Revoke action. Rendered inside the unified ShareDialog (and reused anywhere
 * folder access is managed). Folder-level by design — grants attach to folders.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  useGetGrantsQuery,
  useAddGrantMutation,
  useRevokeGrantMutation,
  useSearchDirectoryQuery,
  useSearchGroupsQuery,
  useSetNodeModeMutation,
  useSetNodeFeedExcludedMutation,
} from '../store/handoffApi'
import { ANYONE_PRINCIPAL, hasAnyoneGrant, isEffectivelyPublic, type FolderLink } from '../lib/acl'
import { GlobeIcon, RssIcon, UsersIcon } from './icons'

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
// GeneralAccess — Public/Private switch
// ---------------------------------------------------------------------------

export interface GeneralAccessProps {
  folderId: string
  /**
   * Root → parent chain (this folder's own link excluded). Absent (or
   * omitted entirely) means "behave as today" — own-grant state only.
   */
  parentChain?: FolderLink[]
  /** This folder's own inheritance mode. Absent is treated as 'inheriting'. */
  folderMode?: 'inheriting' | 'restricted'
}

/**
 * GeneralAccess — the folder's Public/Private switch (ADR-0005), showing the
 * *effective* state: public either because this folder has its own
 * (Anyone, View) grant, or because it inherits publicness from a public
 * ancestor (and hasn't cut that off with `mode:'restricted'`).
 *
 * Making it public always just adds the folder's own Anyone grant. Making it
 * private is more nuanced: if the folder is public purely via its own grant,
 * revoking that grant is enough (unchanged, no confirmation). If it's public
 * (in whole or in part) via inheritance, revoking the local grant alone
 * wouldn't stop it from being public — so that path opens a confirmation
 * dialog that also sets `mode:'restricted'` to cut off inheritance.
 *
 * Renders nothing for viewers who can't manage access (grants GET 403s).
 */
export function GeneralAccess({ folderId, parentChain, folderMode }: GeneralAccessProps) {
  const { data, isLoading, isError } = useGetGrantsQuery({ folderId })
  const [addGrant, { isLoading: saving }] = useAddGrantMutation()
  const [revokeGrant, { isLoading: reverting }] = useRevokeGrantMutation()
  const [setNodeMode, { isLoading: cuttingOff }] = useSetNodeModeMutation()
  const [toggleError, setToggleError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  if (isLoading || isError) return null

  const ownAnyone = hasAnyoneGrant(data?.grants ?? [])
  const inheritedPublic = folderMode !== 'restricted' && isEffectivelyPublic(parentChain ?? [])
  const effectivePublic = ownAnyone || inheritedPublic
  const busy = saving || reverting || cuttingOff

  async function handleToggle() {
    setToggleError(null)
    if (!effectivePublic) {
      const result = await addGrant({ folderId, principalId: ANYONE_PRINCIPAL, level: 'view' })
      if ('error' in result) setToggleError('Failed to update general access. Please try again.')
      return
    }
    if (inheritedPublic) {
      setConfirmOpen(true)
      return
    }
    const result = await revokeGrant({ folderId, principalId: ANYONE_PRINCIPAL })
    if ('error' in result) setToggleError('Failed to update general access. Please try again.')
  }

  async function handleConfirmCutOff() {
    setToggleError(null)
    // Sequential on purpose: CE's data_update is a whole-record read-modify-write
    // ({...existingData, ...updates}), so two concurrent updates to the same
    // record clobber each other's fields — a parallel revoke erased the mode
    // change in live testing (bffless/ce data-update.handler). Mode first; the
    // revoke only fires once the restrict has landed.
    const modeResult = await setNodeMode({ id: folderId, mode: 'restricted' })
    if ('error' in modeResult) {
      setToggleError('Failed to update general access. Please try again.')
      return
    }
    if (ownAnyone) {
      const revokeResult = await revokeGrant({ folderId, principalId: ANYONE_PRINCIPAL })
      if ('error' in revokeResult) {
        setToggleError('Failed to update general access. Please try again.')
        return
      }
    }
    setConfirmOpen(false)
  }

  return (
    <div className="mb-4">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">General access</p>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <GlobeIcon className={`h-4 w-4 shrink-0 ${effectivePublic ? 'text-accent-600' : 'text-muted'}`} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{effectivePublic ? 'Public' : 'Private'}</p>
            <p className="truncate text-xs text-muted">
              {effectivePublic
                ? 'Anyone on the internet can view this folder.'
                : 'Only people with access can view this folder.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={handleToggle}
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {busy ? 'Saving…' : effectivePublic ? 'Make private' : 'Make public'}
        </button>
      </div>
      {toggleError && <p className="mt-1 text-xs text-danger">{toggleError}</p>}
      {confirmOpen && (
        <MakePrivateConfirmDialog
          busy={busy}
          onCancel={() => {
            if (!busy) setConfirmOpen(false)
          }}
          onConfirm={handleConfirmCutOff}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// FeedExclusion — "Exclude from feed" surfacing toggle (#191 / ADR-0007)
// ---------------------------------------------------------------------------

export interface FeedExclusionProps {
  folderId: string
  /** This folder's current feed-exclusion flag. Absent is treated as false. */
  feedExcluded?: boolean
  /** Parent folder id, forwarded for cache invalidation of its listing. */
  parentId?: string
}

/**
 * FeedExclusion — an Owner/admin toggle that keeps this folder's whole subtree
 * out of every RSS feed while leaving it fully browsable (#191 / ADR-0007). It
 * is a surfacing flag, NOT a grant: it never touches access, so an excluded
 * folder can still be public-and-hidden or private-and-fed.
 *
 * Renders nothing for viewers who can't manage the folder (grants GET 403s) —
 * same owner/admin gate as {@link GeneralAccess}.
 */
export function FeedExclusion({ folderId, feedExcluded, parentId }: FeedExclusionProps) {
  const { isLoading, isError } = useGetGrantsQuery({ folderId })
  const [setNodeFeedExcluded, { isLoading: saving }] = useSetNodeFeedExcludedMutation()
  const [error, setError] = useState<string | null>(null)

  if (isLoading || isError) return null

  const excluded = feedExcluded === true

  async function handleToggle() {
    setError(null)
    const result = await setNodeFeedExcluded({ id: folderId, feedExcluded: !excluded, parentId })
    if ('error' in result) setError('Failed to update feed setting. Please try again.')
  }

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <RssIcon className={`h-4 w-4 shrink-0 ${excluded ? 'text-muted' : 'text-accent-600'}`} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{excluded ? 'Hidden from feed' : 'In feed'}</p>
            <p className="truncate text-xs text-muted">
              {excluded
                ? 'This folder and its contents don’t appear in any RSS feed.'
                : 'This folder’s files appear in RSS feeds.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={handleToggle}
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {saving ? 'Saving…' : excluded ? 'Show in feed' : 'Exclude from feed'}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MakePrivateConfirmDialog — cut-off confirmation for inherited public access.
// ---------------------------------------------------------------------------

function MakePrivateConfirmDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Make this folder private?"
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 'var(--z-modal)' }}
      onClick={onCancel}
    >
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <div
        className="share-dialog relative w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-bg text-accent-600">
            <GlobeIcon className="h-4 w-4" />
          </span>
          <h2 className="text-sm font-semibold text-ink">Make this folder private?</h2>
        </div>
        <p className="mt-1.5 text-sm text-muted">
          People who can only see it through a parent folder — including everyone on the internet
          while a parent is public — will lose access. People added directly to this folder keep
          access.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="inline-flex items-center gap-2 rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Make private'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PrincipalSearch — debounced two-section (People / Groups) autocomplete
// ---------------------------------------------------------------------------

/** A group row as returned by `searchGroups` (share-dialog group picker). */
export interface GroupOption {
  id: string
  name: string
  memberCount: number
}

/** "3 members" / "1 member" — used on group rows in both the picker and the access list. */
function formatMemberCount(n: number): string {
  return `${n} member${n === 1 ? '' : 's'}`
}

interface PrincipalSearchProps {
  onSelectUser: (user: { id: string; email: string }) => void
  onSelectGroup: (group: GroupOption) => void
  disabled: boolean
  /** Debounce + text-query + open/dismiss state, all owned by the parent
   * (`PeopleAccess`) so the fetched groups can double as the live
   * member-count lookup for the access list below (never snapshotted). */
  query: string
  onQueryChange: (query: string) => void
  dismissed: boolean
  onDismiss: () => void
  onFocus: () => void
  users: { id: string; email: string }[]
  groups: GroupOption[]
  isFetching: boolean
  /** True once a search has run (debounced query met the length threshold). */
  shouldSearch: boolean
}

function PrincipalSearch({
  onSelectUser,
  onSelectGroup,
  disabled,
  query,
  onQueryChange,
  dismissed,
  onDismiss,
  onFocus,
  users,
  groups,
  isFetching,
  shouldSearch,
}: PrincipalSearchProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const open = shouldSearch && !dismissed

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onDismiss()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onDismiss])

  function handleSelectUser(user: { id: string; email: string }) {
    onSelectUser(user)
    onDismiss()
  }

  function handleSelectGroup(group: GroupOption) {
    onSelectGroup(group)
    onDismiss()
  }

  // Section headers only when BOTH sources have results; a single source
  // (people-only — including the no-groups-feature/404 case, or groups-only)
  // renders as today's flat list with no header.
  const showSectionHeaders = users.length > 0 && groups.length > 0

  return (
    <div ref={containerRef} className="relative flex-1">
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onFocus={onFocus}
        disabled={disabled}
        placeholder="Search people by email…"
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-accent-500 focus:outline-none disabled:opacity-50"
      />
      {isFetching && (
        <div className="absolute right-3 top-2.5">
          <Spinner />
        </div>
      )}
      {open && (users.length > 0 || groups.length > 0) && (
        <div
          data-testid="principal-results"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-md"
        >
          {users.length > 0 && (
            <div>
              {showSectionHeaders && (
                <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-muted">People</p>
              )}
              <ul>
                {users.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-accent-bg"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        handleSelectUser(u)
                      }}
                    >
                      {u.email}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {groups.length > 0 && (
            <div>
              {showSectionHeaders && (
                <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-muted">Groups</p>
              )}
              <ul>
                {groups.map((g) => (
                  <li key={g.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-accent-bg"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        handleSelectGroup(g)
                      }}
                    >
                      <UsersIcon className="h-4 w-4 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate">{g.name}</span>
                      <span className="shrink-0 text-xs text-muted">{formatMemberCount(g.memberCount)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {open && !isFetching && shouldSearch && users.length === 0 && groups.length === 0 && (
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

  // Debounce + text-query + dropdown-dismiss state for the combined
  // People/Groups picker, owned here (not in a self-contained child) so the
  // fetched `searchGroups` data can double as the live member-count lookup
  // for the access list below — the count is never snapshotted onto the
  // grant itself. `dismissed` resets inside the same debounce timeout that
  // lands a new search term, so a fresh result set always re-opens the
  // dropdown (matches the original DirectorySearch behavior).
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [dismissed, setDismissed] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const handleDismiss = useCallback(() => setDismissed(true), [])
  const handleFocus = useCallback(() => setDismissed(false), [])

  const shouldSearch = debouncedQuery.length >= 2

  const { data: dirData, isFetching: dirFetching } = useSearchDirectoryQuery(
    { search: debouncedQuery },
    { skip: !shouldSearch },
  )
  // Same shouldSearch/skip as the people search above, kept consistent on
  // purpose — see PrincipalSearch. A 404 (old CE without the groups feature)
  // is treated as "no groups feature": the section is suppressed and people
  // search is unaffected.
  const { data: groupsData, error: groupsError, isFetching: groupsFetching } = useSearchGroupsQuery(
    { search: debouncedQuery },
    { skip: !shouldSearch },
  )
  const groupsUnavailable = (groupsError as { status?: number } | undefined)?.status === 404

  const userResults = dirData?.users ?? []
  const groupResults = groupsUnavailable ? [] : (groupsData?.groups ?? [])
  const groupsById = new Map(groupResults.map((g) => [g.id, g] as const))

  const grants = (data?.grants ?? []).filter((g) => g.principalId !== ANYONE_PRINCIPAL)

  const accessErrorStatus = isError ? (error as { status?: number }).status : undefined
  const accessError =
    accessErrorStatus === 403 ? 'You do not have permission to manage access for this folder.' : null

  function resetSearch() {
    setQuery('')
    setDebouncedQuery('')
    setDismissed(true)
  }

  async function handleAddUser(user: { id: string; email: string }) {
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

  async function handleAddGroup(group: GroupOption) {
    setAddError(null)
    const result = await addGrant({
      folderId,
      principalId: group.id,
      principalType: 'group',
      principalName: group.name,
      level: 'view',
    })
    if ('error' in result) {
      const status = (result.error as { status?: number }).status
      setAddError(status === 403 ? 'You do not have permission to add grants.' : 'Failed to add access. Please try again.')
    }
  }

  function handleSelectUser(user: { id: string; email: string }) {
    void handleAddUser(user)
    resetSearch()
  }

  function handleSelectGroup(group: GroupOption) {
    void handleAddGroup(group)
    resetSearch()
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
        <PrincipalSearch
          onSelectUser={handleSelectUser}
          onSelectGroup={handleSelectGroup}
          disabled={adding}
          query={query}
          onQueryChange={setQuery}
          dismissed={dismissed}
          onDismiss={handleDismiss}
          onFocus={handleFocus}
          users={userResults}
          groups={groupResults}
          isFetching={dirFetching || groupsFetching}
          shouldSearch={shouldSearch}
        />
        {adding && <Spinner />}
      </div>
      {addError && <p className="mb-2 text-xs text-danger">{addError}</p>}

      {isLoading && <div className="py-3 text-center text-sm text-muted">Loading…</div>}

      {!isLoading && grants.length > 0 && (
        <ul data-testid="grants-list" className="flex flex-col gap-1.5">
          {grants.map((grant) => {
            const isGroup = grant.principalType === 'group'
            const label = isGroup ? (grant.principalName ?? grant.principalId) : (grant.principalEmail ?? grant.principalId)
            const liveGroup = isGroup ? groupsById.get(grant.principalId) : undefined
            return (
              <li
                key={grant.principalId}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {isGroup && (
                    <span data-testid={`grant-icon-${grant.principalId}`}>
                      <UsersIcon className="h-4 w-4 shrink-0 text-muted" />
                    </span>
                  )}
                  <span className="min-w-0 truncate text-sm text-ink">
                    {label}
                    {liveGroup && <span className="text-muted"> · {formatMemberCount(liveGroup.memberCount)}</span>}
                  </span>
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
            )
          })}
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
