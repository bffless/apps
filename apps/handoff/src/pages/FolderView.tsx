/**
 * FolderView — renders any folder (root or sub-folder) by folderId.
 *
 * - Lists sub-folders first (sorted by name), then files (sorted by name).
 * - Folder rows link to /folder/:id; File rows link to /view/:id.
 * - Breadcrumb at the top (root→current).
 * - New-folder control (inline input → createFolder).
 * - Upload control (uploadFile with current folderId as parentId).
 * - Upload Site control (folder-drop or .zip → site bundle upload).
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  useListNodesQuery,
  useGetNodeQuery,
  useUploadFileMutation,
  useUploadSiteMutation,
  useCreateFolderMutation,
} from '../store/handoffApi'
import { buildBreadcrumb } from '../lib/tree'
import { formatBytes } from '../lib/format'
import { filesFromDirectoryInput, filesFromZip } from '../lib/ingest'
import { planSiteUpload } from '../lib/site'
import { useSession, adminLoginUrl } from '../lib/session'
import { evaluateAccess } from '../lib/acl'
import type { FolderLink } from '../lib/acl'
import { ManageAccessPanel } from '../components/ManageAccessPanel'
import type { HandoffNode } from '../lib/nodes'
import type { Crumb } from '../lib/tree'

// ---------------------------------------------------------------------------
// useBreadcrumb — resolves ancestors via repeated getNode calls
// ---------------------------------------------------------------------------

/**
 * Walk the parentId chain from folderId up to 'root', accumulating folder
 * nodes into a map, then build the breadcrumb array.
 *
 * Implemented as a component using a state-driven approach: starts with the
 * current folder, resolves its parent, and so on. Each resolved node is merged
 * into a shared map.
 */
function BreadcrumbItem({ folderId, onResolved }: { folderId: string; onResolved: (node: HandoffNode) => void }) {
  const { data: node } = useGetNodeQuery(folderId, { skip: folderId === 'root' })
  useEffect(() => {
    if (node) onResolved(node)
  }, [node, onResolved])
  return null
}

interface BreadcrumbProps {
  folderId: string
}

/**
 * Inner breadcrumb component that accumulates resolved nodes.
 * Keyed by folderId externally so React remounts it on folder change,
 * which avoids calling setState inside a useEffect.
 *
 * Fold-in fix #1: handleResolved is wrapped in useCallback and guarded with a
 * `visited` ref to prevent cycle-driven infinite state growth.
 */
function BreadcrumbInner({ folderId }: BreadcrumbProps) {
  const [nodesById, setNodesById] = useState<Record<string, HandoffNode>>({})
  // Track which ids we need to resolve (start with folderId, expand as we learn parentIds)
  const [toResolve, setToResolve] = useState<string[]>(
    folderId !== 'root' ? [folderId] : []
  )
  // Visited set — prevents cycles from triggering unbounded state growth
  const visitedRef = useRef<Set<string>>(new Set(folderId !== 'root' ? [folderId] : []))

  const handleResolved = useCallback((node: HandoffNode) => {
    setNodesById((prev) => {
      if (prev[node.id]) return prev // already known
      const next = { ...prev, [node.id]: node }
      // If parent is not root and not yet visited, enqueue it
      if (node.parentId !== 'root' && !visitedRef.current.has(node.parentId)) {
        visitedRef.current.add(node.parentId)
        setToResolve((q) => [...q, node.parentId])
      }
      return next
    })
  }, [])

  const crumbs = buildBreadcrumb(nodesById, folderId)

  return (
    <>
      {/* Invisible resolver components — fire getNode queries */}
      {toResolve.map((id) => (
        <BreadcrumbItem key={id} folderId={id} onResolved={handleResolved} />
      ))}
      {/* Rendered breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1 text-sm text-gray-500">
        {crumbs.map((crumb: Crumb, i: number) => {
          const isLast = i === crumbs.length - 1
          return (
            <span key={crumb.id} className="flex items-center gap-1">
              {i > 0 && <span className="text-gray-300">/</span>}
              {isLast ? (
                <span className="font-medium text-gray-900">{crumb.name}</span>
              ) : crumb.id === 'root' ? (
                <Link to="/" className="hover:text-gray-900 hover:underline">
                  {crumb.name}
                </Link>
              ) : (
                <Link to={`/folder/${crumb.id}`} className="hover:text-gray-900 hover:underline">
                  {crumb.name}
                </Link>
              )}
            </span>
          )
        })}
      </nav>
    </>
  )
}

/**
 * Outer wrapper that forces a remount of BreadcrumbInner when folderId changes,
 * avoiding cascading setState calls inside useEffect.
 */
function Breadcrumb({ folderId }: BreadcrumbProps) {
  return <BreadcrumbInner key={folderId} folderId={folderId} />
}

// ---------------------------------------------------------------------------
// FolderRow / FileRow
// ---------------------------------------------------------------------------

function FolderRow({ node }: { node: HandoffNode }) {
  return (
    <Link
      to={`/folder/${node.id}`}
      className="flex items-center gap-3 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 shadow-sm transition-colors hover:bg-blue-100"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-500">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
          <path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v3.26a3.235 3.235 0 0 1 1.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0 0 16.25 5h-4.836a.25.25 0 0 1-.177-.073L9.823 3.513A1.75 1.75 0 0 0 8.586 3H3.75ZM3.75 9A1.75 1.75 0 0 0 2 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0 0 18 15.25v-4.5A1.75 1.75 0 0 0 16.25 9H3.75Z" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900">{node.name}</p>
        <p className="truncate text-xs text-gray-400">Folder</p>
      </div>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0 text-gray-300">
        <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
      </svg>
    </Link>
  )
}

function FileRow({ node }: { node: HandoffNode }) {
  const hint = node.mime ?? node.type
  return (
    <Link
      to={`/view/${node.id}`}
      className="flex items-center gap-3 rounded-lg border border-gray-100 bg-white px-4 py-3 shadow-sm transition-colors hover:bg-gray-50"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gray-50 text-gray-400">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
          <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900">{node.name}</p>
        <p className="truncate text-xs text-gray-400">{hint}</p>
      </div>
      {node.size !== null && (
        <span className="shrink-0 text-xs text-gray-400">{formatBytes(node.size)}</span>
      )}
    </Link>
  )
}

// ---------------------------------------------------------------------------
// UploadButton
// ---------------------------------------------------------------------------

interface UploadButtonProps {
  onFile: (file: File) => void
  uploading: boolean
}

function UploadButton({ onFile, uploading }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        aria-label="File input"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
          e.target.value = ''
        }}
      />
      <button
        type="button"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {uploading ? (
          <>
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            Uploading…
          </>
        ) : (
          <>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
              <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
            </svg>
            Upload
          </>
        )}
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------
// UploadSiteControl
// ---------------------------------------------------------------------------

interface UploadSiteControlProps {
  folderId: string
  onDone: () => void
}

/**
 * Renders two hidden file inputs (folder-drop and .zip) plus a "Upload site"
 * button that triggers a dropdown/inline UI:
 *   - Ingest files from folder or zip
 *   - Run planSiteUpload
 *   - If entry is auto-detected, proceed. If multiple candidates, show picker.
 *   - If no HTML found, show error.
 *   - Editable site name input (defaults to folder/zip base name).
 *   - Upload progress + errors.
 */
function UploadSiteControl({ folderId, onDone }: UploadSiteControlProps) {
  const folderRef = useRef<HTMLInputElement>(null)
  const zipRef = useRef<HTMLInputElement>(null)

  type Phase = 'idle' | 'picking-entry' | 'uploading' | 'done'
  const [phase, setPhase] = useState<Phase>('idle')
  const [items, setItems] = useState<{ relPath: string; file: File }[]>([])
  const [entry, setEntry] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<string[]>([])
  const [siteName, setSiteName] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)

  const [uploadSite] = useUploadSiteMutation()

  function handleIngest(newItems: { relPath: string; file: File }[], baseName: string) {
    const plan = planSiteUpload(newItems)

    if (plan.files.length === 0) {
      setUploadError('No files found in the selected folder/zip.')
      return
    }

    // plan.files carries the original File objects with normalised relPaths —
    // no string-based re-pairing needed.
    setItems(plan.files)
    setSiteName(baseName)
    setUploadError(null)

    if (plan.candidates.length === 0 && plan.entry === null) {
      setUploadError('No HTML file found. A site requires at least one .html or .htm file.')
      return
    }

    setEntry(plan.entry)
    setCandidates(plan.candidates)
    setPhase('picking-entry')
  }

  async function handleUpload() {
    if (!entry) return
    const trimmedName = siteName.trim() || 'Untitled Site'
    setPhase('uploading')
    setUploadProgress(`Uploading ${items.length} file${items.length !== 1 ? 's' : ''}…`)
    setUploadError(null)

    const result = await uploadSite({ items, entry, name: trimmedName, parentId: folderId })

    if ('error' in result) {
      const err = result.error
      const msg = 'error' in (err as object)
        ? (err as { error: string }).error
        : `Upload failed (${(err as { status: string | number }).status})`
      setUploadError(msg)
      setPhase('picking-entry')
      setUploadProgress(null)
    } else {
      setPhase('idle')
      setUploadProgress(null)
      setItems([])
      setEntry(null)
      setCandidates([])
      setSiteName('')
      onDone()
    }
  }

  function handleReset() {
    setPhase('idle')
    setItems([])
    setEntry(null)
    setCandidates([])
    setSiteName('')
    setUploadError(null)
    setUploadProgress(null)
    if (folderRef.current) folderRef.current.value = ''
    if (zipRef.current) zipRef.current.value = ''
  }

  const isUploading = phase === 'uploading'

  return (
    <div className="flex flex-col gap-2">
      {/* Hidden file inputs */}
      <input
        ref={folderRef}
        type="file"
        className="hidden"
        aria-label="Folder input"
        multiple
        {...{ webkitdirectory: '' }}
        onChange={async (e) => {
          const fl = e.target.files
          if (!fl || fl.length === 0) return
          const ingestedItems = filesFromDirectoryInput(fl)
          // Derive base name from the shared top-level folder
          const firstPath = fl[0]?.webkitRelativePath ?? fl[0]?.name ?? ''
          const baseName = firstPath.split('/')[0] ?? 'site'
          handleIngest(ingestedItems, baseName)
        }}
      />
      <input
        ref={zipRef}
        type="file"
        className="hidden"
        aria-label="Zip input"
        accept=".zip"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          try {
            const ingestedItems = await filesFromZip(file)
            const baseName = file.name.replace(/\.zip$/i, '')
            handleIngest(ingestedItems, baseName)
          } catch {
            setUploadError('Failed to read zip file.')
          }
        }}
      />

      {/* Trigger buttons */}
      {phase === 'idle' && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isUploading}
            onClick={() => folderRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 text-sm font-medium text-purple-700 shadow-sm transition-colors hover:bg-purple-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v3.26a3.235 3.235 0 0 1 1.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0 0 16.25 5h-4.836a.25.25 0 0 1-.177-.073L9.823 3.513A1.75 1.75 0 0 0 8.586 3H3.75ZM3.75 9A1.75 1.75 0 0 0 2 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0 0 18 15.25v-4.5A1.75 1.75 0 0 0 16.25 9H3.75Z" />
            </svg>
            Upload site (folder)
          </button>
          <button
            type="button"
            disabled={isUploading}
            onClick={() => zipRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 text-sm font-medium text-purple-700 shadow-sm transition-colors hover:bg-purple-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
            </svg>
            Upload site (.zip)
          </button>
        </div>
      )}

      {/* Entry picking / confirmation panel */}
      {phase === 'picking-entry' && (
        <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
          <div className="mb-3 flex flex-col gap-2">
            {/* Site name */}
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-700">Site name</span>
              <input
                type="text"
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none"
                placeholder="My Site"
              />
            </label>

            {/* Entry picker (only when multiple candidates) */}
            {candidates.length > 0 && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-700">Entry HTML file</span>
                <select
                  value={entry ?? ''}
                  onChange={(e) => setEntry(e.target.value || null)}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none"
                >
                  <option value="">— pick an entry —</option>
                  {candidates.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
            )}

            {/* Auto-detected entry summary */}
            {entry !== null && candidates.length === 0 && (
              <p className="text-xs text-gray-600">
                Entry: <span className="font-medium text-purple-700">{entry}</span>
                {' '}({items.length} file{items.length !== 1 ? 's' : ''})
              </p>
            )}
          </div>

          {uploadError && (
            <p className="mb-3 text-xs text-red-600">{uploadError}</p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!entry || !siteName.trim()}
              onClick={handleUpload}
              className="rounded-lg bg-purple-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-purple-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Upload site
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Uploading state */}
      {phase === 'uploading' && uploadProgress && (
        <div className="flex items-center gap-2 text-sm text-purple-700">
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          {uploadProgress}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// NewFolderControl
// ---------------------------------------------------------------------------

interface NewFolderControlProps {
  folderId: string
}

function NewFolderControl({ folderId }: NewFolderControlProps) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [createFolder, { isLoading, error }] = useCreateFolderMutation()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const result = await createFolder({ parentId: folderId, name: trimmed })
    if (!('error' in result)) {
      setName('')
      setCreating(false)
    }
  }

  const errorMsg = error
    ? 'error' in error
      ? (error as { error: string }).error
      : `Failed (${(error as { status: string | number }).status})`
    : null

  if (!creating) {
    return (
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.25a.75.75 0 0 0-1.5 0v2.5h-2.5a.75.75 0 0 0 0 1.5h2.5v2.5a.75.75 0 0 0 1.5 0v-2.5h2.5a.75.75 0 0 0 0-1.5h-2.5v-2.5Z" clipRule="evenodd" />
        </svg>
        New Folder
      </button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Folder name"
        disabled={isLoading}
        className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none disabled:opacity-50"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setCreating(false)
            setName('')
          }
        }}
      />
      <button
        type="submit"
        disabled={isLoading || !name.trim()}
        className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
      >
        {isLoading ? 'Creating…' : 'Create'}
      </button>
      <button
        type="button"
        onClick={() => { setCreating(false); setName('') }}
        className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
      >
        Cancel
      </button>
      {errorMsg && <span className="text-xs text-red-600">{errorMsg}</span>}
    </form>
  )
}

// ---------------------------------------------------------------------------
// FolderView
// ---------------------------------------------------------------------------

export interface FolderViewProps {
  folderId: string
}

export function FolderView({ folderId }: FolderViewProps) {
  const { data: rawNodes, isLoading, isError, error } = useListNodesQuery({ parentId: folderId })
  const [uploadFile, { isLoading: uploading, error: uploadError }] = useUploadFileMutation()
  const [uploadDone, setUploadDone] = useState(false)
  const [siteDone, setSiteDone] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const siteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fold-in fix #2: Show folder name in h1 for sub-folders
  const { data: currentFolder } = useGetNodeQuery(folderId, { skip: folderId === 'root' })

  // Session + ACL
  const { session } = useSession()
  const folderLink: FolderLink = {
    ownerId: currentFolder?.ownerId ?? null,
    grants: currentFolder?.grants ?? [],
    mode: currentFolder?.mode ?? 'inheriting',
  }
  const effectiveLevel = evaluateAccess({
    folderChain: [folderLink],
    viewer: {
      userId: session?.authenticated ? session.user.id : undefined,
      isAdmin: session?.authenticated && session.user.role === 'admin',
    },
  })

  const canWrite = effectiveLevel === 'owner' || effectiveLevel === 'edit'
  const canManage = effectiveLevel === 'owner'
  const isPrivate = (currentFolder?.grants ?? []).length === 0 && canManage

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      if (siteTimerRef.current !== null) clearTimeout(siteTimerRef.current)
    }
  }, [])

  async function handleFile(file: File) {
    setUploadDone(false)
    const result = await uploadFile({ file, parentId: folderId })
    if (!('error' in result)) {
      setUploadDone(true)
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setUploadDone(false), 3000)
    }
  }

  function handleSiteDone() {
    setSiteDone(true)
    if (siteTimerRef.current !== null) clearTimeout(siteTimerRef.current)
    siteTimerRef.current = setTimeout(() => setSiteDone(false), 3000)
  }

  const uploadErrorMsg = uploadError
    ? 'error' in uploadError
      ? (uploadError as { error: string }).error
      : `Upload failed (${(uploadError as { status: string | number }).status})`
    : null

  // Sort: folders first (by name), then files (by name)
  const sorted = rawNodes
    ? [...rawNodes].sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1
        if (a.type !== 'folder' && b.type === 'folder') return 1
        return a.name.localeCompare(b.name)
      })
    : []

  const pageTitle = folderId === 'root'
    ? 'My Files'
    : (currentFolder?.name ?? 'Folder')

  // Determine error status for 401/403 handling
  const errorStatus = error ? (error as { status?: number }).status : undefined

  return (
    <div className="container-page py-10">
      {/* Breadcrumb */}
      <Breadcrumb folderId={folderId} />

      {/* Toolbar */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-gray-900">
            {pageTitle}
          </h1>
          {isPrivate && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
              Private
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <button
              type="button"
              onClick={() => setManageOpen((v) => !v)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path d="M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM1.49 15.326a.78.78 0 0 1-.358-.442 3 3 0 0 1 4.308-3.516 6.484 6.484 0 0 0-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 0 1-2.07-.655ZM16.44 15.98a4.97 4.97 0 0 0 2.07-.654.78.78 0 0 0 .357-.442 3 3 0 0 0-4.308-3.517 6.484 6.484 0 0 1 1.907 3.96 2.32 2.32 0 0 1-.026.654ZM18 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5.304 16.19a.844.844 0 0 1-.277-.71 5 5 0 0 1 9.947 0 .843.843 0 0 1-.277.71A6.975 6.975 0 0 1 10 18a6.974 6.974 0 0 1-4.696-1.81Z" />
              </svg>
              Manage access
            </button>
          )}
          {canWrite && (
            <>
              <NewFolderControl folderId={folderId} />
              <UploadButton onFile={handleFile} uploading={uploading} />
            </>
          )}
        </div>
      </div>

      {/* Manage Access Panel */}
      {manageOpen && canManage && (
        <div className="mb-6">
          <ManageAccessPanel folderId={folderId} onClose={() => setManageOpen(false)} />
        </div>
      )}

      {/* Upload Site control (only for writers) */}
      {canWrite && (
        <div className="mb-4">
          <UploadSiteControl folderId={folderId} onDone={handleSiteDone} />
        </div>
      )}

      {/* Upload feedback */}
      {uploadErrorMsg && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {uploadErrorMsg}
        </div>
      )}
      {uploadDone && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          File uploaded successfully.
        </div>
      )}
      {siteDone && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          Site uploaded successfully.
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
      )}

      {/* Error — 401 / 403 / generic */}
      {isError && !isLoading && errorStatus === 401 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-8 text-center">
          <p className="mb-3 text-sm text-yellow-800">Sign in to view this folder</p>
          <button
            type="button"
            onClick={() => { window.location.href = adminLoginUrl(window.location.href) }}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            Sign in
          </button>
        </div>
      )}
      {isError && !isLoading && errorStatus === 403 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-8 text-center text-sm text-red-600">
          You don&apos;t have access to this folder.
        </div>
      )}
      {isError && !isLoading && errorStatus !== 401 && errorStatus !== 403 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-8 text-center text-sm text-red-600">
          {error && 'error' in (error as object)
            ? (error as { error: string }).error
            : 'Failed to load. Please refresh.'}
        </div>
      )}

      {/* Empty */}
      {!isLoading && !isError && sorted.length === 0 && (
        <div className="py-16 text-center text-sm text-gray-400">
          Empty folder — upload a file or create a sub-folder
        </div>
      )}

      {/* Listing */}
      {!isLoading && !isError && sorted.length > 0 && (
        <div className="flex flex-col gap-2">
          {sorted.map((node) =>
            node.type === 'folder' ? (
              <FolderRow key={node.id} node={node} />
            ) : (
              <FileRow key={node.id} node={node} />
            )
          )}
        </div>
      )}
    </div>
  )
}
