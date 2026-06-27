/**
 * FolderView — renders any folder (root or sub-folder) by folderId.
 *
 * Layout (ADR-0004): a sortable table/list-hybrid listing (icon+name / type /
 * size / Added), a within-folder filter, a single "New ▾" menu plus an
 * always-visible drop target, and a per-row kebab (Open + Copy link; Delete /
 * Rename / Move are reserved for when their endpoints exist). Empty, loading
 * (skeleton), no-results, and access-error states are all authored.
 *
 * The ancestor-resolution + ACL machinery is unchanged from the original; only
 * the presentation and the add/listing surfaces were reworked.
 */

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react'
import { Link, useNavigate } from 'react-router-dom'
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
import { CopyLinkButton } from '../components/CopyLinkButton'
import { buildBreadcrumb, buildAncestorFolderChain } from '../lib/tree'
import { formatBytes, formatDate } from '../lib/format'
import {
  filesFromDirectoryInput,
  filesFromZip,
  filesFromDataTransfer,
  dataTransferHasDirectory,
} from '../lib/ingest'
import { planSiteUpload } from '../lib/site'
import { planFolderImport } from '../lib/folderImport'
import { useSession, adminLoginUrl } from '../lib/session'
import { evaluateAccess } from '../lib/acl'
import { toast } from '../lib/toast'
import { ShareDialog } from '../components/ShareDialog'
import { Menu } from '../components/Menu'
import {
  NodeIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  UploadIcon,
  FolderPlusIcon,
  ArchiveIcon,
  KebabIcon,
  LinkIcon,
  ExternalIcon,
  ShareIcon,
  SearchIcon,
  XIcon,
} from '../components/icons'
import type { HandoffNode } from '../lib/nodes'
import type { Crumb } from '../lib/tree'
import type { RootState } from '../store'

// ---------------------------------------------------------------------------
// Ancestor resolution (unchanged logic) — drives breadcrumb AND ACL eval.
// ---------------------------------------------------------------------------

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

function AncestorNodesInner({
  folderId,
  onUpdate,
}: {
  folderId: string
  onUpdate: (nodesById: Record<string, HandoffNode>, complete: boolean) => void
}) {
  const [nodesById, setNodesById] = useState<Record<string, HandoffNode>>({})
  const [toResolve, setToResolve] = useState<string[]>(folderId !== 'root' ? [folderId] : [])
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

  const complete =
    folderId === 'root' ||
    (() => {
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

interface BreadcrumbProps {
  folderId: string
  onChainUpdate: (nodesById: Record<string, HandoffNode>, complete: boolean) => void
}

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
      <AncestorNodesInner key={folderId} folderId={folderId} onUpdate={handleUpdate} />
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted">
        {crumbs.map((crumb: Crumb, i: number) => {
          const isLast = i === crumbs.length - 1
          return (
            <span key={crumb.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRightIcon className="h-4 w-4 text-muted/60" />}
              {isLast ? (
                <span className="font-medium text-ink">{crumb.name}</span>
              ) : (
                <Link
                  to={crumb.id === 'root' ? '/' : `/folder/${crumb.id}`}
                  className="rounded px-1 no-underline transition-colors hover:bg-surface-2 hover:text-ink"
                >
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

function Breadcrumb({ folderId, onChainUpdate }: BreadcrumbProps) {
  return <BreadcrumbInner key={folderId} folderId={folderId} onChainUpdate={onChainUpdate} />
}

// ---------------------------------------------------------------------------
// UploadFolderControl — Site-or-tree import engine. Triggers (folder/zip
// pickers) are exposed via the imperative handle so the "New ▾" menu and the
// dropzone drive it; the choice/entry panels still render inline when active.
// ---------------------------------------------------------------------------

interface UploadFolderControlProps {
  folderId: string
  onDone: (message: string) => void
}

export interface UploadFolderControlHandle {
  ingest: (items: { relPath: string; file: File }[], baseName: string) => void
  pickFolder: () => void
  pickZip: () => void
}

const UploadFolderControl = forwardRef<UploadFolderControlHandle, UploadFolderControlProps>(
  function UploadFolderControl({ folderId, onDone }, ref) {
    const folderRef = useRef<HTMLInputElement>(null)
    const zipRef = useRef<HTMLInputElement>(null)

    type Phase = 'idle' | 'choosing' | 'picking-entry' | 'confirm-folder' | 'uploading' | 'importing'
    const [phase, setPhase] = useState<Phase>('idle')

    const [rawItems, setRawItems] = useState<{ relPath: string; file: File }[]>([])
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
      setPhase(folderPlan.hasHtml ? 'choosing' : 'confirm-folder')
    }

    useImperativeHandle(
      ref,
      () => ({
        ingest: handleIngest,
        pickFolder: () => folderRef.current?.click(),
        pickZip: () => zipRef.current?.click(),
      }),
      [],
    )

    async function handleUploadSite() {
      if (!entry) return
      const trimmedName = siteName.trim() || 'Untitled Site'
      setPhase('uploading')
      setUploadProgress(`Uploading ${plural(siteItems.length, 'file')}…`)
      setUploadError(null)
      const result = await uploadSite({ items: siteItems, entry, name: trimmedName, parentId: folderId })
      if ('error' in result) {
        const err = result.error
        const msg =
          'error' in (err as object)
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
      setUploadProgress(`Importing ${plural(folderCount, 'folder')} and ${plural(fileCount, 'file')}…`)
      setUploadError(null)
      const result = await importFolder({ items: rawItems, parentId: folderId })
      if ('error' in result) {
        const err = result.error
        const msg =
          'error' in (err as object)
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
        {/* Hidden inputs — clicked by the New ▾ menu via the imperative handle */}
        <input
          ref={folderRef}
          type="file"
          className="hidden"
          aria-label="Folder input"
          multiple
          {...{ webkitdirectory: '' }}
          onChange={(e) => {
            const fl = e.target.files
            if (!fl || fl.length === 0) {
              setUploadError('No files were selected from that folder.')
              return
            }
            try {
              const ingestedItems = filesFromDirectoryInput(fl)
              const firstPath = fl[0]?.webkitRelativePath ?? fl[0]?.name ?? ''
              const baseName = firstPath.split('/')[0] || 'folder'
              handleIngest(ingestedItems, baseName)
            } catch (err) {
              setUploadError(err instanceof Error ? err.message : 'Failed to read the selected folder.')
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

        {uploadError && <p className="text-sm text-danger">{uploadError}</p>}

        {phase === 'choosing' && (
          <div className="rounded-lg border border-accent-200 bg-accent-bg p-4">
            <p className="mb-3 text-sm text-ink">
              This folder contains HTML
              {rootIndexHtml && (
                <>
                  {' '}
                  (including a root <span className="font-medium">index.html</span>)
                </>
              )}
              . How should it be imported?
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setPhase('picking-entry')}
                className="rounded-lg bg-accent-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-700"
              >
                Import as Site{rootIndexHtml && <span className="ml-1 opacity-80">(recommended)</span>}
              </button>
              <button
                type="button"
                onClick={handleImportFolder}
                className="rounded-lg border border-border bg-surface px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-surface-2"
              >
                Import as folder of files
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {phase === 'confirm-folder' && (
          <div className="rounded-lg border border-accent-200 bg-accent-bg p-4">
            <p className="mb-3 text-sm text-ink">
              Import as a browsable folder: {plural(folderCount, 'sub-folder')} and{' '}
              {plural(fileCount, 'file')} into this folder.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleImportFolder}
                className="rounded-lg bg-accent-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-700"
              >
                Import folder
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {phase === 'picking-entry' && (
          <div className="rounded-lg border border-accent-200 bg-accent-bg p-4">
            <div className="mb-3 flex flex-col gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Site name</span>
                <input
                  type="text"
                  value={siteName}
                  onChange={(e) => setSiteName(e.target.value)}
                  className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent-500 focus:outline-none"
                  placeholder="My Site"
                />
              </label>
              {candidates.length > 0 && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">Entry HTML file</span>
                  <select
                    value={entry ?? ''}
                    onChange={(e) => setEntry(e.target.value || null)}
                    className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent-500 focus:outline-none"
                  >
                    <option value="">— pick an entry —</option>
                    {candidates.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {entry !== null && candidates.length === 0 && (
                <p className="text-sm text-muted">
                  Entry: <span className="font-medium text-accent-600">{entry}</span>{' '}
                  ({plural(siteItems.length, 'file')})
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!entry || !siteName.trim()}
                onClick={handleUploadSite}
                className="rounded-lg bg-accent-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Upload site
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {isBusy && uploadProgress && (
          <div className="flex items-center gap-2 text-sm text-accent-600">
            <Spinner />
            {uploadProgress}
          </div>
        )}
      </div>
    )
  },
)

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  )
}

/** Inline "create folder" form, opened from the New ▾ menu. */
function NewFolderInline({
  folderId,
  onClose,
}: {
  folderId: string
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [createFolder, { isLoading, error }] = useCreateFolderMutation()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const result = await createFolder({ parentId: folderId, name: trimmed })
    if (!('error' in result)) {
      setName('')
      onClose()
    }
  }

  const errorMsg = error
    ? 'error' in error
      ? (error as { error: string }).error
      : `Failed (${(error as { status: string | number }).status})`
    : null

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New folder name"
        disabled={isLoading}
        className="min-w-56 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-accent-500 focus:outline-none disabled:opacity-50"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setName('')
            onClose()
          }
        }}
      />
      <button
        type="submit"
        disabled={isLoading || !name.trim()}
        className="rounded-lg bg-accent-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-700 disabled:opacity-50"
      >
        {isLoading ? 'Creating…' : 'Create'}
      </button>
      <button
        type="button"
        onClick={() => {
          setName('')
          onClose()
        }}
        className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2"
      >
        Cancel
      </button>
      {errorMsg && <span className="text-xs text-danger">{errorMsg}</span>}
    </form>
  )
}

// ---------------------------------------------------------------------------
// Listing table
// ---------------------------------------------------------------------------

type SortKey = 'name' | 'added' | 'size'
type SortDir = 'asc' | 'desc'

const TYPE_LABEL: Record<HandoffNode['type'], string> = {
  folder: 'Folder',
  site: 'Site',
  file: 'File',
}

function typeLabel(node: HandoffNode): string {
  if (node.type !== 'file') return TYPE_LABEL[node.type]
  const ext = node.name.toLowerCase().split('.').pop()
  return ext && ext !== node.name.toLowerCase() ? ext.toUpperCase() : 'File'
}

function SortHeader({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
  className = '',
}: {
  label: string
  col: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
  className?: string
}) {
  const active = sortKey === col
  return (
    <th className={`px-3 py-2 text-left text-xs font-medium text-muted ${className}`}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-ink ${active ? 'text-ink' : ''}`}
      >
        {label}
        {active &&
          (sortDir === 'asc' ? (
            <ChevronUpIcon className="h-3.5 w-3.5" />
          ) : (
            <ChevronDownIcon className="h-3.5 w-3.5" />
          ))}
      </button>
    </th>
  )
}

interface ShareTarget {
  folderId: string
  title: string
  nodeId?: string
  isFile?: boolean
}

function RowKebab({
  node,
  canManage,
  copyState,
  onCopyLink,
  onShare,
}: {
  node: HandoffNode
  canManage: boolean
  copyState: 'idle' | 'busy' | 'copied' | 'error'
  onCopyLink: () => void
  onShare: () => void
}) {
  const navigate = useNavigate()
  const to = node.type === 'folder' ? `/folder/${node.id}` : `/view/${node.id}`
  const items: import('../components/Menu').MenuItem[] = [
    {
      label: 'Open',
      icon: <ExternalIcon className="h-4 w-4" />,
      onSelect: () => navigate(to),
    },
  ]
  if (canManage) {
    items.push({ label: 'Share…', icon: <ShareIcon className="h-4 w-4" />, onSelect: onShare })
  }
  if (canManage && node.type !== 'folder') {
    const label =
      copyState === 'copied' ? 'Copied!' : copyState === 'error' ? 'Copy failed' : 'Copy link'
    items.push({ label, icon: <LinkIcon className="h-4 w-4" />, onSelect: onCopyLink })
  }
  return (
    <Menu
      label={`Actions for ${node.name}`}
      align="end"
      items={items}
      trigger={({ ref, onClick, onKeyDown, ...aria }) => (
        <button
          type="button"
          ref={ref as React.Ref<HTMLButtonElement>}
          onClick={(e) => {
            e.preventDefault()
            onClick()
          }}
          onKeyDown={onKeyDown}
          {...aria}
          aria-label={`Actions for ${node.name}`}
          className="row-kebab flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <KebabIcon className="h-5 w-5" />
        </button>
      )}
    />
  )
}

function ListingRow({
  node,
  canManage,
  copyState,
  onCopyLink,
  onShare,
}: {
  node: HandoffNode
  canManage: boolean
  copyState: 'idle' | 'busy' | 'copied' | 'error'
  onCopyLink: () => void
  onShare: () => void
}) {
  const to = node.type === 'folder' ? `/folder/${node.id}` : `/view/${node.id}`
  const iconColor =
    node.type === 'folder' ? 'text-folder' : node.type === 'site' ? 'text-site' : 'text-file'

  return (
    <tr className="group border-b border-border/60 transition-colors last:border-0 hover:bg-accent-bg/60">
      <td className="py-0">
        <Link
          to={to}
          className="flex items-center gap-3 px-3 py-2.5 no-underline"
          aria-label={`Open ${node.name}`}
        >
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 ${iconColor}`}>
            <NodeIcon type={node.type} name={node.name} mime={node.mime} className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">{node.name}</span>
            <span className="block truncate text-xs text-muted sm:hidden">
              {typeLabel(node)}
              {node.size !== null && ` · ${formatBytes(node.size)}`}
            </span>
          </span>
        </Link>
      </td>
      <td className="hidden px-3 py-2.5 text-sm text-muted sm:table-cell">{typeLabel(node)}</td>
      <td className="hidden px-3 py-2.5 text-right text-sm tabular-nums text-muted sm:table-cell">
        {node.size !== null ? formatBytes(node.size) : '—'}
      </td>
      <td className="hidden px-3 py-2.5 text-right text-sm tabular-nums text-muted md:table-cell">
        {formatDate(node.createdAt)}
      </td>
      <td className="px-2 py-1.5 text-right">
        <RowKebab
          node={node}
          canManage={canManage}
          copyState={copyState}
          onCopyLink={onCopyLink}
          onShare={onShare}
        />
      </td>
    </tr>
  )
}

function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <tbody>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i} className="border-b border-border/60 last:border-0">
          <td className="px-3 py-2.5">
            <div className="flex items-center gap-3">
              <div className="skeleton h-9 w-9 rounded-md" />
              <div className="skeleton h-4 w-44 rounded" />
            </div>
          </td>
          <td className="hidden px-3 py-2.5 sm:table-cell">
            <div className="skeleton h-4 w-12 rounded" />
          </td>
          <td className="hidden px-3 py-2.5 sm:table-cell">
            <div className="skeleton ml-auto h-4 w-12 rounded" />
          </td>
          <td className="hidden px-3 py-2.5 md:table-cell">
            <div className="skeleton ml-auto h-4 w-12 rounded" />
          </td>
          <td className="px-2 py-2.5" />
        </tr>
      ))}
    </tbody>
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
  const [uploadFile, { error: uploadError }] = useUploadFileMutation()
  const [uploadedNodes, setUploadedNodes] = useState<HandoffNode[]>([])
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [filter, setFilter] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const uploadFolderRef = useRef<UploadFolderControlHandle>(null)
  const filesInputRef = useRef<HTMLInputElement>(null)

  const [ancestorNodesById, setAncestorNodesById] = useState<Record<string, HandoffNode>>({})
  const [ancestorChainComplete, setAncestorChainComplete] = useState(folderId === 'root')

  const handleChainUpdate = useCallback(
    (nodesById: Record<string, HandoffNode>, complete: boolean) => {
      setAncestorNodesById(nodesById)
      setAncestorChainComplete(complete)
    },
    [],
  )

  const { data: currentFolder } = useGetNodeQuery(folderId, { skip: folderId === 'root' })

  const shareLinkFolderId = useSelector((s: RootState) => s.handoff.shareLinkFolderId)
  const isShareMode = !!shareLinkFolderId

  const { session } = useSession()

  const { chain: folderChain } = buildAncestorFolderChain(ancestorNodesById, folderId)
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

  const canWrite = chainReady && (effectiveLevel === 'owner' || effectiveLevel === 'edit')
  const canManage = chainReady && effectiveLevel === 'owner'

  const { data: folderLinks } = useListShareLinksQuery({ folderId }, { skip: !canManage })
  const copy = useCopyFileShareLink(folderId, folderLinks)

  function fileCopyStatus(nodeId: string): 'idle' | 'busy' | 'copied' | 'error' {
    if (copy.busyId === nodeId) return 'busy'
    if (copy.copiedId === nodeId) return 'copied'
    if (copy.errorId === nodeId) return 'error'
    return 'idle'
  }

  const isPrivate = (currentFolder?.grants ?? []).length === 0 && canManage

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUploadedNodes([])
    setFilter('')
    setCreatingFolder(false)
  }, [folderId])

  async function handleFile(file: File) {
    const result = await uploadFile({ file, parentId: folderId })
    if (!('error' in result)) {
      // Managers get the inline "copy a share link" panel; others a toast.
      if (canManage) setUploadedNodes((prev) => [...prev, result.data])
      else toast('File uploaded')
    }
  }

  function handleDragOver(e: React.DragEvent) {
    if (!canWrite) return
    e.preventDefault()
    setDragActive(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    if (e.currentTarget === e.target) setDragActive(false)
  }

  async function handleDrop(e: React.DragEvent) {
    if (!canWrite) return
    e.preventDefault()
    setDragActive(false)
    const hasDir = dataTransferHasDirectory(e.dataTransfer)
    if (!hasDir) {
      for (const f of Array.from(e.dataTransfer.files)) await handleFile(f)
      return
    }
    const items = await filesFromDataTransfer(e.dataTransfer)
    if (items.length === 0) return
    const baseName = items[0].relPath.split('/')[0] || 'folder'
    uploadFolderRef.current?.ingest(items, baseName)
  }

  function handleImportDone(message: string) {
    toast(message)
  }

  function onSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(k)
      setSortDir(k === 'added' ? 'desc' : 'asc')
    }
  }

  const uploadErrorMsg = uploadError
    ? 'error' in uploadError
      ? (uploadError as { error: string }).error
      : `Upload failed (${(uploadError as { status: string | number }).status})`
    : null

  // Filter (within-folder) then sort: folders grouped before leaves; within
  // each group, by the chosen key/direction.
  const q = filter.trim().toLowerCase()
  const filtered = (rawNodes ?? []).filter((n) => (q ? n.name.toLowerCase().includes(q) : true))
  const dirMul = sortDir === 'asc' ? 1 : -1
  const sorted = [...filtered].sort((a, b) => {
    const aFolder = a.type === 'folder'
    const bFolder = b.type === 'folder'
    if (aFolder !== bFolder) return aFolder ? -1 : 1
    if (sortKey === 'added') return (a.createdAt - b.createdAt) * dirMul
    if (sortKey === 'size') return ((a.size ?? -1) - (b.size ?? -1)) * dirMul
    return a.name.localeCompare(b.name) * dirMul
  })

  const pageTitle = folderId === 'root' ? 'My Files' : (currentFolder?.name ?? 'Folder')
  const errorStatus = error ? (error as { status?: number }).status : undefined
  const hasItems = sorted.length > 0
  const totalCount = rawNodes?.length ?? 0

  const newMenuItems: import('../components/Menu').MenuItem[] = [
    {
      label: 'Upload files',
      icon: <UploadIcon className="h-4 w-4" />,
      onSelect: () => filesInputRef.current?.click(),
    },
    {
      label: 'Upload folder or .zip',
      hint: 'Render an index.html as a Site, or import as files',
      icon: <ArchiveIcon className="h-4 w-4" />,
      onSelect: () => uploadFolderRef.current?.pickFolder(),
    },
    'separator',
    {
      label: 'New folder',
      icon: <FolderPlusIcon className="h-4 w-4" />,
      onSelect: () => setCreatingFolder(true),
    },
  ]

  return (
    <div
      className="container-page py-8"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* hidden plain-files input (multiple) */}
      <input
        ref={filesInputRef}
        type="file"
        multiple
        className="hidden"
        aria-label="Files input"
        onChange={async (e) => {
          const fl = e.target.files
          if (fl) for (const f of Array.from(fl)) await handleFile(f)
          e.target.value = ''
        }}
      />

      <Breadcrumb folderId={folderId} onChainUpdate={handleChainUpdate} />

      {/* Toolbar */}
      <div className="mb-5 mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{pageTitle}</h1>
          {isPrivate && (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">
              Private
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <button
              type="button"
              onClick={() => setShareTarget({ folderId, title: pageTitle })}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium text-ink shadow-sm transition-colors hover:bg-surface-2"
            >
              <ShareIcon className="h-4 w-4 text-muted" />
              Share
            </button>
          )}
          {canWrite && (
            <Menu
              label="Add"
              align="end"
              items={newMenuItems}
              trigger={({ ref, onClick, onKeyDown, ...aria }) => (
                <button
                  type="button"
                  ref={ref as React.Ref<HTMLButtonElement>}
                  onClick={onClick}
                  onKeyDown={onKeyDown}
                  {...aria}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-700"
                >
                  <PlusIcon className="h-4 w-4" />
                  New
                  <ChevronDownIcon className="h-4 w-4 opacity-80" />
                </button>
              )}
            />
          )}
        </div>
      </div>

      {/* Unified Share dialog (toolbar + row kebab) */}
      {shareTarget && (
        <ShareDialog
          folderId={shareTarget.folderId}
          title={shareTarget.title}
          nodeId={shareTarget.nodeId}
          isFile={shareTarget.isFile}
          onClose={() => setShareTarget(null)}
        />
      )}

      {/* New-folder inline form */}
      {creatingFolder && canWrite && (
        <div className="mb-4 rounded-lg border border-border bg-surface p-3">
          <NewFolderInline folderId={folderId} onClose={() => setCreatingFolder(false)} />
        </div>
      )}

      {/* Upload engine — panels render here when a folder/zip is being ingested */}
      {canWrite && (
        <div className="mb-4">
          <UploadFolderControl ref={uploadFolderRef} folderId={folderId} onDone={handleImportDone} />
        </div>
      )}

      {/* Persistent, always-visible drop target */}
      {canWrite && (
        <div
          className={`mb-5 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-3 text-sm transition-colors ${
            dragActive
              ? 'border-accent-500 bg-accent-bg text-accent-700'
              : 'border-border bg-surface-2/40 text-muted'
          }`}
        >
          <UploadIcon className="h-4 w-4" />
          {dragActive ? 'Drop to upload here' : 'Drag files or a folder here, or use New ▾'}
        </div>
      )}

      {/* Feedback */}
      {uploadErrorMsg && (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger">
          {uploadErrorMsg}
        </div>
      )}
      {canManage && uploadedNodes.length > 0 && (
        <div className="mb-4 rounded-lg border border-success/30 bg-success-bg px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-success">Uploaded — copy a share link</p>
            <button
              type="button"
              onClick={() => setUploadedNodes([])}
              className="rounded p-1 text-success transition-colors hover:bg-success/10"
              aria-label="Dismiss"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {uploadedNodes.map((n) => (
              <li
                key={n.id}
                className="flex items-center gap-2 rounded-lg border border-success/20 bg-surface px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{n.name}</span>
                <CopyLinkButton
                  status={fileCopyStatus(n.id)}
                  onClick={() => void copy.copyLink(n.id)}
                  className="shrink-0 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Filter — only when the folder actually has items */}
      {!isLoading && !isError && totalCount > 0 && (
        <div className="relative mb-3 max-w-xs">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter this folder…"
            className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-8 text-sm text-ink transition-colors focus:border-accent-500 focus:outline-none"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter('')}
              aria-label="Clear filter"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {/* Listing */}
      {isLoading && (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <table className="w-full">
            <SkeletonRows />
          </table>
        </div>
      )}

      {isError && !isLoading && errorStatus === 401 && !isShareMode && (
        <div className="rounded-xl border border-amber-200 bg-edit-bg px-4 py-10 text-center">
          <p className="mb-3 text-sm text-ink">Sign in to view this folder</p>
          <button
            type="button"
            onClick={() => {
              window.location.href = adminLoginUrl(window.location.href)
            }}
            className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-700"
          >
            Sign in
          </button>
        </div>
      )}
      {isError && !isLoading && errorStatus === 401 && isShareMode && (
        <div className="rounded-xl border border-danger/30 bg-danger-bg px-4 py-10 text-center text-sm text-danger">
          This folder is outside your share link&apos;s scope.
        </div>
      )}
      {isError && !isLoading && errorStatus === 403 && (
        <div className="rounded-xl border border-danger/30 bg-danger-bg px-4 py-10 text-center text-sm text-danger">
          You don&apos;t have access to this folder.
        </div>
      )}
      {isError && !isLoading && errorStatus !== 401 && errorStatus !== 403 && (
        <div className="rounded-xl border border-danger/30 bg-danger-bg px-4 py-10 text-center text-sm text-danger">
          {error && 'error' in (error as object)
            ? (error as { error: string }).error
            : 'Failed to load. Please refresh.'}
        </div>
      )}

      {/* Empty (truly empty folder) */}
      {!isLoading && !isError && totalCount === 0 && (
        <EmptyState
          canWrite={canWrite}
          isRoot={folderId === 'root'}
          onNew={() => filesInputRef.current?.click()}
        />
      )}

      {/* No filter results */}
      {!isLoading && !isError && totalCount > 0 && !hasItems && (
        <div className="rounded-xl border border-border bg-surface px-4 py-12 text-center">
          <p className="text-sm text-ink">No items match “{filter}”.</p>
          <button
            type="button"
            onClick={() => setFilter('')}
            className="mt-2 text-sm font-medium text-accent-600 hover:text-accent-700"
          >
            Clear filter
          </button>
        </div>
      )}

      {/* Table */}
      {!isLoading && !isError && hasItems && (
        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
          <table className="w-full">
            <thead className="border-b border-border bg-surface-2/50">
              <tr>
                <SortHeader label="Name" col="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <th className="hidden px-3 py-2 text-left text-xs font-medium text-muted sm:table-cell">
                  Type
                </th>
                <SortHeader
                  label="Size"
                  col="size"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  className="hidden text-right sm:table-cell [&>button]:ml-auto"
                />
                <SortHeader
                  label="Added"
                  col="added"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  className="hidden text-right md:table-cell [&>button]:ml-auto"
                />
                <th className="w-12 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((node) => (
                <ListingRow
                  key={node.id}
                  node={node}
                  canManage={canManage}
                  copyState={fileCopyStatus(node.id)}
                  onCopyLink={() => void copy.copyLink(node.id)}
                  onShare={() =>
                    setShareTarget(
                      node.type === 'folder'
                        ? { folderId: node.id, title: node.name }
                        : { folderId, title: node.name, nodeId: node.id, isFile: true },
                    )
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty state — teaches the interface; primary CTA when the viewer can write.
// ---------------------------------------------------------------------------

function EmptyState({
  canWrite,
  isRoot,
  onNew,
}: {
  canWrite: boolean
  isRoot: boolean
  onNew: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-bg text-accent-600">
        <UploadIcon className="h-7 w-7" />
      </div>
      <h2 className="text-base font-semibold text-ink">
        {isRoot ? 'Nothing here yet' : 'This folder is empty'}
      </h2>
      <p className="mt-1 max-w-sm text-sm text-muted">
        {canWrite
          ? 'Drag files or a folder anywhere on this page, or use New to upload content and create sub-folders.'
          : 'There’s nothing to see in this folder yet.'}
      </p>
      {canWrite && (
        <button
          type="button"
          onClick={onNew}
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-700"
        >
          <UploadIcon className="h-4 w-4" />
          Upload files
        </button>
      )}
    </div>
  )
}
