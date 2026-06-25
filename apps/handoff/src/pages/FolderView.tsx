/**
 * FolderView — renders any folder (root or sub-folder) by folderId.
 *
 * - Lists sub-folders first (sorted by name), then files (sorted by name).
 * - Folder rows link to /folder/:id; File rows link to /view/:id.
 * - Breadcrumb at the top (root→current).
 * - New-folder control (inline input → createFolder).
 * - Upload control (uploadFile with current folderId as parentId).
 */

import { useRef, useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  useListNodesQuery,
  useGetNodeQuery,
  useUploadFileMutation,
  useCreateFolderMutation,
} from '../store/handoffApi'
import { buildBreadcrumb } from '../lib/tree'
import { formatBytes } from '../lib/format'
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
 */
function BreadcrumbInner({ folderId }: BreadcrumbProps) {
  const [nodesById, setNodesById] = useState<Record<string, HandoffNode>>({})
  // Track which ids we need to resolve (start with folderId, expand as we learn parentIds)
  const [toResolve, setToResolve] = useState<string[]>(
    folderId !== 'root' ? [folderId] : []
  )

  function handleResolved(node: HandoffNode) {
    setNodesById((prev) => {
      if (prev[node.id]) return prev // already known
      const next = { ...prev, [node.id]: node }
      // If parent is not root and not yet known, add to resolve queue
      if (node.parentId !== 'root' && !next[node.parentId]) {
        setToResolve((q) => (q.includes(node.parentId) ? q : [...q, node.parentId]))
      }
      return next
    })
  }

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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
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

  return (
    <div className="container-page py-10">
      {/* Breadcrumb */}
      <Breadcrumb folderId={folderId} />

      {/* Toolbar */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-gray-900">
          {folderId === 'root' ? 'My Files' : 'Folder'}
        </h1>
        <div className="flex items-center gap-2">
          <NewFolderControl folderId={folderId} />
          <UploadButton onFile={handleFile} uploading={uploading} />
        </div>
      </div>

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

      {/* Loading */}
      {isLoading && (
        <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
      )}

      {/* Error */}
      {isError && !isLoading && (
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
