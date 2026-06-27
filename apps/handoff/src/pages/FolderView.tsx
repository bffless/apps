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
import { useSelector } from 'react-redux'
import {
  useListNodesQuery,
  useGetNodeQuery,
  useUploadFileMutation,
  useUploadSiteMutation,
  useImportFolderMutation,
  useCreateFolderMutation,
  useListShareLinksQuery,
} from '../store/handoffApi'
import { useCopyFileShareLink } from '../store/useCopyFileShareLink'
import { CopyLinkButton, type CopyStatus } from '../components/CopyLinkButton'
import { buildBreadcrumb, buildAncestorFolderChain } from '../lib/tree'
import { formatBytes } from '../lib/format'
import { filesFromDirectoryInput, filesFromZip } from '../lib/ingest'
import { planSiteUpload } from '../lib/site'
import { planFolderImport } from '../lib/folderImport'
import { useSession, adminLoginUrl } from '../lib/session'
import { evaluateAccess } from '../lib/acl'
import { ManageAccessPanel } from '../components/ManageAccessPanel'
import type { HandoffNode } from '../lib/nodes'
import type { Crumb } from '../lib/tree'
import type { RootState } from '../store'

// ---------------------------------------------------------------------------
// useAncestorNodes — resolves ancestor chain via repeated getNode calls
// ---------------------------------------------------------------------------

/**
 * Walk the parentId chain from folderId up to 'root', accumulating resolved
 * folder nodes into a map. Returns the map and whether the full chain has been
 * resolved (complete=true).
 *
 * Used for BOTH breadcrumb rendering and the ACL evaluation in FolderView, so
 * there is a single source of truth for the ancestor chain.
 *
 * Keyed externally (BreadcrumbInner is remounted on folderId change) so we
 * never call setState inside a useEffect render cycle.
 */
function AncestorNodeResolver({
  folderId,
  onResolved,
}: {
  folderId: string
  onResolved: (node: HandoffNode) => void
}) {
  const { data: node } = useGetNodeQuery(folderId, { skip: folderId === 'root' })
  useEffect(() => {
    if (node) onResolved(node)
  }, [node, onResolved])
  return null
}

/**
 * Inner hook-component pair. This is the inner component; the outer wrapper
 * (useAncestorNodesWrapper) remounts it when folderId changes.
 */
function AncestorNodesInner({
  folderId,
  onUpdate,
}: {
  folderId: string
  onUpdate: (nodesById: Record<string, HandoffNode>, complete: boolean) => void
}) {
  const [nodesById, setNodesById] = useState<Record<string, HandoffNode>>({})
  const [toResolve, setToResolve] = useState<string[]>(
    folderId !== 'root' ? [folderId] : []
  )
  const visitedRef = useRef<Set<string>>(new Set(folderId !== 'root' ? [folderId] : []))

  const handleResolved = useCallback((node: HandoffNode) => {
    setNodesById((prev) => {
      if (prev[node.id]) return prev
      const next = { ...prev, [node.id]: node }
      if (node.parentId !== 'root' && !visitedRef.current.has(node.parentId)) {
        visitedRef.current.add(node.parentId)
        setToResolve((q) => [...q, node.parentId])
      }
      return next
    })
  }, [])

  // Determine completeness: all nodes resolved and the topmost node's parentId is 'root'.
  const complete = folderId === 'root' || (() => {
    // Walk the resolved map from folderId upward
    let cur = folderId
    let hops = 0
    while (cur !== 'root' && hops < 64) {
      const n = nodesById[cur]
      if (!n) return false
      cur = n.parentId
      hops++
    }
    return cur === 'root'
  })()

  // Notify parent of updated state
  useEffect(() => {
    onUpdate(nodesById, complete)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesById, complete])

  return (
    <>
      {toResolve.map((id) => (
        <AncestorNodeResolver key={id} folderId={id} onResolved={handleResolved} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// useBreadcrumb — resolves ancestors via repeated getNode calls
// ---------------------------------------------------------------------------

interface BreadcrumbProps {
  folderId: string
  /** Called whenever the resolved node map or completeness changes. */
  onChainUpdate: (nodesById: Record<string, HandoffNode>, complete: boolean) => void
}

/**
 * Renders breadcrumb nav AND drives ancestor resolution.
 * Remounts AncestorNodesInner when folderId changes.
 */
function BreadcrumbInner({ folderId, onChainUpdate }: BreadcrumbProps) {
  const [nodesById, setNodesById] = useState<Record<string, HandoffNode>>({})

  const handleUpdate = useCallback(
    (updated: Record<string, HandoffNode>, complete: boolean) => {
      setNodesById(updated)
      onChainUpdate(updated, complete)
    },
    [onChainUpdate],
  )

  const crumbs = buildBreadcrumb(nodesById, folderId)

  return (
    <>
      {/* Invisible resolver components — fire getNode queries */}
      <AncestorNodesInner
        key={folderId}
        folderId={folderId}
        onUpdate={handleUpdate}
      />
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
function Breadcrumb({ folderId, onChainUpdate }: BreadcrumbProps) {
  return <BreadcrumbInner key={folderId} folderId={folderId} onChainUpdate={onChainUpdate} />
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

function FileRow({
  node,
  copyStatus,
  onCopyLink,
}: {
  node: HandoffNode
  copyStatus?: CopyStatus
  onCopyLink?: () => void
}) {
  const hint = node.mime ?? node.type
  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-100 bg-white px-4 py-3 shadow-sm transition-colors hover:bg-gray-50">
      <Link to={`/view/${node.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gray-50 text-gray-400">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
            <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-900">{node.name}</p>
          <p className="truncate text-xs text-gray-400">{hint}</p>
        </div>
      </Link>
      {node.size !== null && (
        <span className="shrink-0 text-xs text-gray-400">{formatBytes(node.size)}</span>
      )}
      {onCopyLink && <CopyLinkButton status={copyStatus ?? 'idle'} onClick={onCopyLink} />}
    </div>
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
// UploadFolderControl
// ---------------------------------------------------------------------------

interface UploadFolderControlProps {
  folderId: string
  onDone: (message: string) => void
}

/**
 * "Upload folder" — a single entry (folder-drop or .zip) that branches on the
 * ingested content:
 *   - HTML detected → offer a choice: **Import as Site** (iframe-rendered Entry,
 *     the original behaviour) or **Import as folder of files** (browsable tree).
 *     Site is recommended when a root `index.html` is present.
 *   - No HTML → import straight as a browsable Folder tree of Files (no Site
 *     option) — the case a folder of `.md`/PDFs/images wants.
 *
 * Phases:
 *   idle → choosing (HTML) | confirm-folder (no HTML)
 *   choosing → picking-entry (Site) | confirm-folder (folder of files)
 *   picking-entry → uploading (uploadSite)
 *   confirm-folder → importing (importFolder)
 *
 * Errors are visible in every phase, so an ingest failure is never a silent
 * no-op. The Site branch reuses `planSiteUpload`; the tree branch reuses
 * `planFolderImport` — both share the same path normalisation.
 */
function UploadFolderControl({ folderId, onDone }: UploadFolderControlProps) {
  const folderRef = useRef<HTMLInputElement>(null)
  const zipRef = useRef<HTMLInputElement>(null)

  type Phase = 'idle' | 'choosing' | 'picking-entry' | 'confirm-folder' | 'uploading' | 'importing'
  const [phase, setPhase] = useState<Phase>('idle')

  // Original ingested items (raw relPaths) — passed to importFolder, which
  // normalises once internally. Re-normalising already-stripped paths could
  // strip a second shared top dir, so the tree branch must get the originals.
  const [rawItems, setRawItems] = useState<{ relPath: string; file: File }[]>([])
  // Normalised site items (carry File + normalised relPath) for the Site branch.
  const [siteItems, setSiteItems] = useState<{ relPath: string; file: File }[]>([])
  const [entry, setEntry] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<string[]>([])
  const [siteName, setSiteName] = useState('')
  const [hasHtml, setHasHtml] = useState(false)
  const [rootIndexHtml, setRootIndexHtml] = useState(false)
  const [folderCount, setFolderCount] = useState(0)
  const [fileCount, setFileCount] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)

  const [uploadSite] = useUploadSiteMutation()
  const [importFolder] = useImportFolderMutation()

  function plural(n: number, word: string) {
    return `${n} ${word}${n !== 1 ? 's' : ''}`
  }

  function handleIngest(newItems: { relPath: string; file: File }[], baseName: string) {
    const folderPlan = planFolderImport(newItems)

    if (folderPlan.files.length === 0) {
      setUploadError('No files found in the selected folder/zip.')
      return
    }

    const sitePlan = planSiteUpload(newItems)
    setRawItems(newItems)
    setSiteItems(sitePlan.files)
    setEntry(sitePlan.entry)
    setCandidates(sitePlan.candidates)
    setHasHtml(folderPlan.hasHtml)
    setRootIndexHtml(folderPlan.rootIndexHtml)
    setFolderCount(folderPlan.dirs.length)
    setFileCount(folderPlan.files.length)
    setSiteName(baseName)
    setUploadError(null)

    // HTML present → let the user choose Site vs folder of files.
    // No HTML → there is nothing to render as a Site; go straight to import.
    setPhase(folderPlan.hasHtml ? 'choosing' : 'confirm-folder')
  }

  async function handleUploadSite() {
    if (!entry) return
    const trimmedName = siteName.trim() || 'Untitled Site'
    setPhase('uploading')
    setUploadProgress(`Uploading ${plural(siteItems.length, 'file')}…`)
    setUploadError(null)

    const result = await uploadSite({ items: siteItems, entry, name: trimmedName, parentId: folderId })

    if ('error' in result) {
      const err = result.error
      const msg = 'error' in (err as object)
        ? (err as { error: string }).error
        : `Upload failed (${(err as { status: string | number }).status})`
      setUploadError(msg)
      setPhase('picking-entry')
      setUploadProgress(null)
    } else {
      handleReset()
      onDone('Site uploaded successfully.')
    }
  }

  async function handleImportFolder() {
    setPhase('importing')
    setUploadProgress(
      `Importing ${plural(folderCount, 'folder')} and ${plural(fileCount, 'file')}…`,
    )
    setUploadError(null)

    const result = await importFolder({ items: rawItems, parentId: folderId })

    if ('error' in result) {
      const err = result.error
      const msg = 'error' in (err as object)
        ? (err as { error: string }).error
        : `Import failed (${(err as { status: string | number }).status})`
      setUploadError(msg)
      setPhase(hasHtml ? 'choosing' : 'confirm-folder')
      setUploadProgress(null)
      return
    }

    const data = result.data
    const summary = `Imported ${plural(data.foldersCreated, 'folder')} and ${plural(data.filesUploaded, 'file')}.`
    if (data.failures.length > 0) {
      // Partial import: the listing still refreshes with what landed, but make
      // the failures visible rather than swallowing them.
      resetFields()
      setUploadError(
        `${summary} ${plural(data.failures.length, 'file')} failed: ` +
          data.failures.map((f) => f.relPath).join(', '),
      )
    } else {
      handleReset()
      onDone(summary)
    }
  }

  function resetFields() {
    setPhase('idle')
    setRawItems([])
    setSiteItems([])
    setEntry(null)
    setCandidates([])
    setSiteName('')
    setHasHtml(false)
    setRootIndexHtml(false)
    setFolderCount(0)
    setFileCount(0)
    setUploadProgress(null)
    if (folderRef.current) folderRef.current.value = ''
    if (zipRef.current) zipRef.current.value = ''
  }

  function handleReset() {
    resetFields()
    setUploadError(null)
  }

  const isBusy = phase === 'uploading' || phase === 'importing'

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
          if (!fl || fl.length === 0) {
            setUploadError('No files were selected from that folder.')
            return
          }
          try {
            const ingestedItems = filesFromDirectoryInput(fl)
            // Derive base name from the shared top-level folder
            const firstPath = fl[0]?.webkitRelativePath ?? fl[0]?.name ?? ''
            const baseName = firstPath.split('/')[0] || 'folder'
            handleIngest(ingestedItems, baseName)
          } catch (err) {
            setUploadError(
              err instanceof Error ? err.message : 'Failed to read the selected folder.',
            )
          }
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

      {/* Error message — visible in every phase (incl. idle), so an ingest
          failure isn't a silent no-op. */}
      {uploadError && (
        <p className="text-xs text-red-600">{uploadError}</p>
      )}

      {/* Trigger buttons */}
      {phase === 'idle' && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isBusy}
            title="Drop a folder. If it contains an index.html we'll offer to render it as a Site; otherwise it imports as browsable folders + files."
            onClick={() => folderRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 text-sm font-medium text-purple-700 shadow-sm transition-colors hover:bg-purple-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v3.26a3.235 3.235 0 0 1 1.75-.51h12.5c.644 0 1.245.188 1.75.51V6.75A1.75 1.75 0 0 0 16.25 5h-4.836a.25.25 0 0 1-.177-.073L9.823 3.513A1.75 1.75 0 0 0 8.586 3H3.75ZM3.75 9A1.75 1.75 0 0 0 2 10.75v4.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0 0 18 15.25v-4.5A1.75 1.75 0 0 0 16.25 9H3.75Z" />
            </svg>
            Upload folder
          </button>
          <button
            type="button"
            disabled={isBusy}
            title="Upload a .zip — same flow as a folder drop."
            onClick={() => zipRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 text-sm font-medium text-purple-700 shadow-sm transition-colors hover:bg-purple-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
            </svg>
            Upload .zip
          </button>
        </div>
      )}

      {/* Choice panel — HTML detected: Site or folder of files */}
      {phase === 'choosing' && (
        <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
          <p className="mb-3 text-xs text-gray-600">
            This folder contains HTML
            {rootIndexHtml && <> (including a root <span className="font-medium">index.html</span>)</>}.
            How should it be imported?
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setPhase('picking-entry')}
              className="rounded-lg bg-purple-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-purple-800"
            >
              Import as Site{rootIndexHtml && <span className="ml-1 opacity-80">(recommended)</span>}
            </button>
            <button
              type="button"
              onClick={handleImportFolder}
              className="rounded-lg border border-purple-300 bg-white px-4 py-1.5 text-sm font-medium text-purple-700 hover:bg-purple-100"
            >
              Import as folder of files
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

      {/* Folder-of-files confirm (no HTML, or chose folder from the HTML branch) */}
      {phase === 'confirm-folder' && (
        <div className="rounded-lg border border-purple-200 bg-purple-50 p-4">
          <p className="mb-3 text-xs text-gray-600">
            Import as a browsable folder: {plural(folderCount, 'sub-folder')} and{' '}
            {plural(fileCount, 'file')} into this folder.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleImportFolder}
              className="rounded-lg bg-purple-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-purple-800"
            >
              Import folder
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

      {/* Entry picking / confirmation panel (Site branch) */}
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
                {' '}({plural(siteItems.length, 'file')})
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!entry || !siteName.trim()}
              onClick={handleUploadSite}
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

      {/* Busy state (site upload or folder import) */}
      {isBusy && uploadProgress && (
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
  const [uploadedNodes, setUploadedNodes] = useState<HandoffNode[]>([])
  const [importDoneMsg, setImportDoneMsg] = useState<string | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const siteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Ancestor chain state — updated by the Breadcrumb component as nodes resolve.
  const [ancestorNodesById, setAncestorNodesById] = useState<Record<string, HandoffNode>>({})
  const [ancestorChainComplete, setAncestorChainComplete] = useState(folderId === 'root')

  const handleChainUpdate = useCallback(
    (nodesById: Record<string, HandoffNode>, complete: boolean) => {
      setAncestorNodesById(nodesById)
      setAncestorChainComplete(complete)
    },
    [],
  )

  // Fold-in fix #2: Show folder name in h1 for sub-folders
  const { data: currentFolder } = useGetNodeQuery(folderId, { skip: folderId === 'root' })

  // Share-link session — set by ShareLinkEntry when a visitor opens /s/:token.
  const shareLinkFolderId = useSelector((s: RootState) => s.handoff.shareLinkFolderId)
  const isShareMode = !!shareLinkFolderId

  // Session + ACL
  const { session } = useSession()

  // Build the full root→target FolderLink[] chain from the resolved ancestor map.
  // While the chain is still resolving, fall back to a single-entry chain (partial)
  // which may under-grant but never throws. Controls are shown once complete.
  const { chain: folderChain } = buildAncestorFolderChain(ancestorNodesById, folderId)

  // For the root folder the chain is always complete (single synthetic root link).
  const chainReady = folderId === 'root' || ancestorChainComplete

  const effectiveLevel = evaluateAccess({
    folderChain,
    viewer: isShareMode
      ? { shareLinkFolderId }
      : {
          userId: session?.authenticated ? session.user.id : undefined,
          isAdmin: session?.authenticated && session.user.role === 'admin',
        },
  })

  // Only show write/manage controls once the full chain has resolved to avoid
  // flashing disabled controls while ancestors are still loading.
  const canWrite = chainReady && (effectiveLevel === 'owner' || effectiveLevel === 'edit')
  const canManage = chainReady && effectiveLevel === 'owner'

  // Manager-only: load folder links so "Copy link" can reuse one token per folder.
  const { data: folderLinks } = useListShareLinksQuery({ folderId }, { skip: !canManage })
  const copy = useCopyFileShareLink(folderId, folderLinks)

  function fileCopyStatus(nodeId: string): CopyStatus {
    if (copy.busyId === nodeId) return 'busy'
    if (copy.copiedId === nodeId) return 'copied'
    if (copy.errorId === nodeId) return 'error'
    return 'idle'
  }

  const isPrivate = (currentFolder?.grants ?? []).length === 0 && canManage

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      if (siteTimerRef.current !== null) clearTimeout(siteTimerRef.current)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUploadedNodes([])
  }, [folderId])

  async function handleFile(file: File) {
    setUploadDone(false)
    const result = await uploadFile({ file, parentId: folderId })
    if (!('error' in result)) {
      setUploadDone(true)
      setUploadedNodes((prev) => [...prev, result.data])
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setUploadDone(false), 3000)
    }
  }

  function handleImportDone(message: string) {
    setImportDoneMsg(message)
    if (siteTimerRef.current !== null) clearTimeout(siteTimerRef.current)
    siteTimerRef.current = setTimeout(() => setImportDoneMsg(null), 4000)
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
      {/* Breadcrumb — also drives ancestor resolution for ACL evaluation */}
      <Breadcrumb folderId={folderId} onChainUpdate={handleChainUpdate} />

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

      {/* Upload Folder control (only for writers) */}
      {canWrite && (
        <div className="mb-4">
          <UploadFolderControl folderId={folderId} onDone={handleImportDone} />
        </div>
      )}

      {/* Upload feedback */}
      {uploadErrorMsg && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {uploadErrorMsg}
        </div>
      )}
      {uploadDone && uploadedNodes.length === 0 && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          File uploaded successfully.
        </div>
      )}
      {uploadedNodes.length > 0 && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-green-800">Uploaded — copy a share link</p>
            <button
              type="button"
              onClick={() => setUploadedNodes([])}
              className="rounded p-1 text-green-700 hover:bg-green-100"
              aria-label="Dismiss"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
              </svg>
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {uploadedNodes.map((n) => (
              <li key={n.id} className="flex items-center gap-2 rounded-lg border border-green-200 bg-white px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-gray-800">{n.name}</span>
                <CopyLinkButton
                  status={fileCopyStatus(n.id)}
                  onClick={() => void copy.copyLink(n.id)}
                  className="shrink-0 rounded-lg border border-green-300 bg-white px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-50 disabled:opacity-50"
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {importDoneMsg && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {importDoneMsg}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
      )}

      {/* Error — 401 / 403 / generic */}
      {isError && !isLoading && errorStatus === 401 && !isShareMode && (
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
      {isError && !isLoading && errorStatus === 401 && isShareMode && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-8 text-center text-sm text-red-600">
          This folder is outside your share link&apos;s scope.
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
              <FileRow
                key={node.id}
                node={node}
                copyStatus={fileCopyStatus(node.id)}
                onCopyLink={canManage ? () => void copy.copyLink(node.id) : undefined}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}
