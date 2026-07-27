/**
 * File viewer for Handoff — `ViewerBody`, rendered by the `/blob/<path>` and
 * legacy `/view/:id` routes (see `src/pages/PathPages.tsx`), which own the
 * share-token claim + id resolution before mounting this component.
 *
 * Resolves a node by id via `useGetNodeQuery`, shows a sticky control bar
 * (Back, title, open-in-new-tab, fullscreen, download), and renders the
 * content region based on `previewFor(node)`.
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  useGetNodeQuery,
  useGetRootMetaQuery,
  useGetSignedUrlQuery,
  useDeleteNodeMutation,
} from '../store/handoffApi'
import { previewFor, hasViewSource } from '../lib/preview'
import { renderMarkdown, markdownDocument } from '../lib/markdown'
import { viewerBase } from '../lib/contentPath'
import { nodeFileName, type HandoffNode } from '../lib/nodes'
import { useSession, fetchWithReauth } from '../lib/session'
import { canShareParentFolder } from '../lib/shareGate'
import { canDeleteNode } from '../lib/deleteGate'
import { childIsPublic, type FolderLink } from '../lib/acl'
import { rootMetaNode } from '../lib/rootNode'
import { ShareDialog } from '../components/ShareDialog'
import { AncestorNodes } from '../components/AncestorNodes'
import { NodeDetails } from '../components/NodeDetails'
import { Menu } from '../components/Menu'
import { TrashIcon, ChevronRightIcon, GlobeIcon, KebabIcon } from '../components/icons'
import { parentFolderPath, buildAncestorFolderChain } from '../lib/tree'
import { treeUrl, parentPath, blobUrl } from '../lib/pathUrl'
import { useClaimShareToken } from '../store/useClaimShareToken'
import { useEmbedMode, isFramed } from '../lib/embed'
import { InvalidLink } from '../components/InvalidLink'
import { toast } from '../lib/toast'
import { shouldClaimToken } from '../lib/share'

// ---------------------------------------------------------------------------
// Control bar
// ---------------------------------------------------------------------------

interface ControlBarProps {
  node: HandoffNode
  contentRef: React.RefObject<HTMLDivElement | null>
  /** Whether the current preview kind supports a raw-source view. */
  canViewSource: boolean
  /** True when the content region is currently showing raw source. */
  showSource: boolean
  onToggleSource: () => void
}

/**
 * Back target: the parent folder's canonical path URL, falling back to the
 * legacy `/folder/:id` route when the node has no path yet (rollout safety).
 */
function backTarget(node: HandoffNode): string {
  return node.path != null && node.path !== ''
    ? treeUrl(parentPath(node.path))
    : parentFolderPath(node.parentId)
}

function CodeIcon() {
  return (
    <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path fillRule="evenodd" d="M6.28 5.22a.75.75 0 0 1 0 1.06L2.56 10l3.72 3.72a.75.75 0 0 1-1.06 1.06L1.22 10.53a.75.75 0 0 1 0-1.06l4-4a.75.75 0 0 1 1.06 0Zm7.44 0a.75.75 0 0 1 1.06 0l4 4a.75.75 0 0 1 0 1.06l-4 4a.75.75 0 1 1-1.06-1.06L17.44 10l-3.72-3.72a.75.75 0 0 1 0-1.06ZM11.377 2.011a.75.75 0 0 1 .612.867l-2 11.5a.75.75 0 0 1-1.478-.257l2-11.5a.75.75 0 0 1 .866-.61Z" clipRule="evenodd" />
    </svg>
  )
}

function ShareIcon() {
  return (
    <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path d="M13 4.5a2.5 2.5 0 1 1 .702 1.737L6.97 9.604a2.518 2.518 0 0 1 0 .792l6.733 3.367a2.5 2.5 0 1 1-.671 1.341L6.3 11.737a2.5 2.5 0 1 1 0-3.474l6.733-3.367A2.515 2.515 0 0 1 13 4.5Z" />
    </svg>
  )
}

function ControlBar({ node, contentRef, canViewSource, showSource, onToggleSource }: ControlBarProps) {
  const navigate = useNavigate()
  const { session } = useSession()
  const authed = session?.authenticated === true

  const isRoot = node.parentId === 'root'
  // Look up the parent folder to read its ownerId for the share gate.
  // Skip for guests (unauthenticated) to avoid a discarded 401 on the parent fetch.
  const { data: parentNode } = useGetNodeQuery(node.parentId, { skip: isRoot || !authed })
  const canShare = canShareParentFolder({ session, parentNode: parentNode ?? undefined })
  const canDelete = canDeleteNode({ session, node, parentNode: parentNode ?? undefined })
  const backTo = backTarget(node)

  // Root → parent ancestor chain — powers the effective-visibility badge
  // (#254) and ShareDialog's `parentChain`/`folderMode` (#253), which the
  // dialog needs to see publicness inherited from an ancestor folder. Guests
  // skip resolution entirely (same 401-avoidance as the parentNode fetch
  // above); they get no badge — whatever they're viewing, they can access.
  const [ancestorNodesById, setAncestorNodesById] = useState<Record<string, HandoffNode>>({})
  const [ancestorChainComplete, setAncestorChainComplete] = useState(isRoot)
  // Reset the walk when navigating to a file in a different folder
  // (adjust-state-during-render, same pattern as ViewerBody's showSource).
  const [prevParentId, setPrevParentId] = useState(node.parentId)
  if (node.parentId !== prevParentId) {
    setPrevParentId(node.parentId)
    setAncestorNodesById({})
    setAncestorChainComplete(node.parentId === 'root')
  }
  const handleChainUpdate = useCallback(
    (nodesById: Record<string, HandoffNode>, complete: boolean) => {
      setAncestorNodesById(nodesById)
      setAncestorChainComplete(complete)
    },
    [],
  )
  const { data: rootMeta, isLoading: rootMetaLoading } = useGetRootMetaQuery(undefined, {
    skip: !authed,
  })
  const rootNode = rootMetaNode(rootMeta)

  const { chain } = buildAncestorFolderChain(ancestorNodesById, node.parentId, rootNode)
  const chainTail = chain[chain.length - 1]
  // Live chain tail (see AncestorNodes): the walker's map is first-write-wins,
  // but `parentNode` above DOES refetch when the Share dialog mutates the
  // parent's grants/mode — swap it in so badge and dialog track those live.
  const liveChain: FolderLink[] =
    parentNode && chainTail?.id === parentNode.id
      ? [
          ...chain.slice(0, -1),
          {
            id: parentNode.id,
            ownerId: parentNode.ownerId,
            grants: parentNode.grants,
            mode: parentNode.mode,
          },
        ]
      : chain
  const chainReady = isRoot || ancestorChainComplete
  // No "Private" flash while the chain / rootMeta are still loading (same
  // guard as FolderView's publicReady) — render nothing until both resolve.
  const publicReady = authed && chainReady && !rootMetaLoading
  const isNodePublic = publicReady && childIsPublic(liveChain, node)
  // ShareDialog's parentChain contract: root → the TARGET folder's parent,
  // the target's own link EXCLUDED (its own grants come from the live grants
  // query inside the dialog). The target is the file's containing folder.
  const dialogParentChain = chainTail?.id === node.parentId ? liveChain.slice(0, -1) : liveChain

  // "Open" must not point at the raw bytes for Markdown: the content endpoint
  // serves it as text/markdown, which browsers download instead of rendering —
  // making the button a second Download. Send the new tab to the chromeless
  // viewer, which shows the *rendered* document at a shareable URL.
  const openUrl =
    previewFor(node) === 'markdown' && node.path ? `${blobUrl(node.path)}?embed=1` : node.url

  const [shareOpen, setShareOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteNode] = useDeleteNodeMutation()

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteNode({ id: node.id, parentId: node.parentId }).unwrap()
      toast(`Deleted “${node.name}”.`)
      navigate(backTo)
    } catch {
      setDeleting(false)
      toast(`Couldn’t delete “${node.name}”. Please try again.`, 'error')
    }
  }

  function handleFullscreen() {
    if (contentRef.current) {
      contentRef.current.requestFullscreen().catch(() => { /* ignore */ })
    }
  }

  // The breadcrumb reflects the PATH, so the trailing crumb shows the file's
  // real name (the content-path basename), not the display title — the two can
  // differ (e.g. an API-set title), and the title has its own home in the
  // details block.
  const fileName = nodeFileName(node)

  return (
    <div
      className="sticky top-14 flex items-center gap-2 border-b border-border bg-surface/90 px-4 py-2 backdrop-blur"
      style={{ zIndex: 'var(--z-sticky)' }}
    >
      {/* Back — returns to the parent Folder (PRD story 27), not always Home. */}
      <button
        type="button"
        onClick={() => navigate(backTo)}
        className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-sm text-muted no-underline transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
        </svg>
        Back
      </button>

      {/* Location breadcrumb (PRD story 26): ~/ › [parent folder] › file.
          The parent folder crumb only renders once its node has resolved (it is
          skipped for guests / root items), so the chain degrades gracefully. */}
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-sm text-muted">
        <Link
          to="/"
          className="shrink-0 rounded px-1 no-underline transition-colors hover:bg-surface-2 hover:text-ink"
        >
          ~/
        </Link>
        {/* Parent crumb yields to the filename on narrow screens — `~/ › file`
            is the mobile chain; Back already covers the parent hop. */}
        {!isRoot && parentNode && (
          <span className="hidden min-w-0 items-center gap-1 sm:flex">
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted/60" />
            <Link
              to={backTo}
              className="truncate rounded px-1 no-underline transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {parentNode.name}
            </Link>
          </span>
        )}
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted/60" />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{fileName}</span>
      </nav>

      {/* Title/description live in a popover off the bar (not a chrome row of
          their own) — writers of the parent folder can edit, same gate as Delete. */}
      <NodeDetails key={node.id} node={node} canEdit={canDelete} />

      {/* Renderless ancestor walk feeding the badge + Share dialog chain. */}
      {authed && !isRoot && (
        <AncestorNodes key={node.parentId} folderId={node.parentId} onUpdate={handleChainUpdate} />
      )}

      {/* Effective Public/Private badge (#254) — same treatment as the folder
          header's, truthful once the chain resolves ("Public" or "Private",
          never a loading flash of either). */}
      {publicReady &&
        (isNodePublic ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-100 px-2 py-0.5 text-xs font-medium text-accent-700">
            <GlobeIcon className="h-3 w-3" />
            Public
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">
            Private
          </span>
        ))}

      {/* Share — owners/admins of the parent folder. Root items: disabled + explanation. */}
      {isRoot ? (
        session?.authenticated ? (
          <button
            type="button"
            disabled
            title="Move this into a folder to share it"
            className="inline-flex cursor-not-allowed items-center gap-1 rounded px-2 py-1 text-sm text-muted/50"
          >
            <ShareIcon />
            <span className="hidden sm:inline">Share</span>
          </button>
        ) : null
      ) : canShare ? (
        <>
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-muted no-underline transition-colors hover:bg-surface-2 hover:text-ink"
            title="Share"
            aria-haspopup="dialog"
          >
            <ShareIcon />
            <span className="hidden sm:inline">Share</span>
          </button>
          {shareOpen && (
            <ShareDialog
              folderId={node.parentId}
              title={node.name}
              nodeId={node.id}
              isFile
              parentChain={dialogParentChain}
              folderMode={parentNode?.mode ?? 'inheriting'}
              onClose={() => setShareOpen(false)}
            />
          )}
        </>
      ) : null}

      {/* View source ⇄ View rendered — only for source-capable kinds */}
      {canViewSource && (
        <button
          type="button"
          onClick={onToggleSource}
          className="hidden items-center gap-1 rounded px-2 py-1 text-sm text-muted no-underline transition-colors hover:bg-surface-2 hover:text-ink sm:inline-flex"
          title={showSource ? 'View rendered' : 'View source'}
          aria-pressed={showSource}
        >
          <CodeIcon />
          {showSource ? 'View rendered' : 'View source'}
        </button>
      )}

      {/* Open in new tab */}
      {openUrl && (
        <a
          href={openUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hidden items-center gap-1 rounded px-2 py-1 text-sm text-muted no-underline transition-colors hover:bg-surface-2 hover:text-ink sm:inline-flex"
          title="Open in new tab"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path fillRule="evenodd" d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" clipRule="evenodd" />
            <path fillRule="evenodd" d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z" clipRule="evenodd" />
          </svg>
          Open
        </a>
      )}

      {/* Fullscreen */}
      <button
        type="button"
        onClick={handleFullscreen}
        className="hidden items-center gap-1 rounded px-2 py-1 text-sm text-muted no-underline transition-colors hover:bg-surface-2 hover:text-ink sm:inline-flex"
        title="Fullscreen"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path d="M13.28 7.78a.75.75 0 0 0-1.06-1.06l-1.97 1.97V5.75a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 .75.75h4.5a.75.75 0 0 0 0-1.5h-2.94l1.97-1.97ZM6.72 12.22a.75.75 0 0 0 1.06 1.06l1.97-1.97v2.94a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.94l-1.97 1.97Z" />
        </svg>
        Fullscreen
      </button>

      {/* Download — not shown for sites (use Open-in-new-tab instead) */}
      {node.url && node.type !== 'site' && (
        <a
          href={node.url}
          download={node.name}
          className="hidden items-center gap-1 rounded px-2 py-1 text-sm text-muted no-underline transition-colors hover:bg-surface-2 hover:text-ink sm:inline-flex"
          title="Download"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
            <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
          </svg>
          Download
        </a>
      )}

      {/* Delete — writers only */}
      {canDelete && (
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="hidden items-center gap-1 rounded px-2 py-1 text-sm text-muted transition-colors hover:bg-danger-bg hover:text-danger sm:inline-flex"
          title="Delete"
        >
          <TrashIcon className="h-4 w-4" />
          Delete
        </button>
      )}

      {/* Overflow menu (narrow screens only): the secondary actions above are
          hidden below `sm` and collapse into this kebab, so the bar stays one
          uncropped row instead of clipping off the right edge. */}
      <span className="sm:hidden">
        <Menu
          label="More actions"
          align="end"
          items={[
            ...(canViewSource
              ? [{ label: showSource ? 'View rendered' : 'View source', onSelect: onToggleSource }]
              : []),
            ...(openUrl
              ? [{ label: 'Open in new tab', onSelect: () => window.open(openUrl, '_blank', 'noopener,noreferrer') }]
              : []),
            { label: 'Fullscreen', onSelect: handleFullscreen },
            ...(node.url && node.type !== 'site'
              ? [{
                  label: 'Download',
                  onSelect: () => {
                    const a = document.createElement('a')
                    a.href = node.url as string
                    a.download = node.name
                    a.click()
                  },
                }]
              : []),
            ...(canDelete
              ? ['separator' as const, { label: 'Delete', danger: true, onSelect: () => setConfirmOpen(true) }]
              : []),
          ]}
          trigger={({ ref, onClick, onKeyDown, ...aria }) => (
            <button
              type="button"
              ref={ref as React.Ref<HTMLButtonElement>}
              onClick={onClick}
              onKeyDown={onKeyDown}
              {...aria}
              aria-label="More actions"
              title="More actions"
              className="inline-flex items-center rounded px-2 py-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <KebabIcon className="h-4 w-4" />
            </button>
          )}
        />
      </span>

      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Delete ${node.name}`}
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ zIndex: 'var(--z-modal)' }}
          onClick={() => {
            if (!deleting) setConfirmOpen(false)
          }}
        >
          <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
          <div
            className="share-dialog relative w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-danger-bg text-danger">
                <TrashIcon className="h-4 w-4" />
              </span>
              <h2 className="text-sm font-semibold text-ink">
                Delete {node.type === 'site' ? 'site' : 'file'}?
              </h2>
            </div>
            <p className="mt-1.5 text-sm text-muted">
              <span className="font-medium text-ink">{node.name}</span> will be permanently deleted.
              This can’t be undone.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setConfirmOpen(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleDelete}
                className="inline-flex items-center gap-2 rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting && (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                )}
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Content renderers
// ---------------------------------------------------------------------------

type MdState = { url: string; doc: string } | null

/**
 * Renders Markdown into a same-origin iframe (structural storage, Slice 1).
 *
 * The document sets `<base href>` to the file's own Folder on the content
 * endpoint (`viewerBase`), so a relative reference like `assets/logo.png`
 * resolves to the real sibling content URL — with no rewriting of the stored
 * Markdown. Sanitization (DOMPurify, in `renderMarkdown`) is retained before
 * injection; the iframe is same-origin/unsandboxed, consistent with how Sites
 * already render (ADR-0001).
 *
 * The `embed` prop suppresses app chrome (`?embed=1`), which "Open in new tab"
 * also uses for a standalone Markdown tab. The *rendering* half of embed mode —
 * handing the reading measure and the link target to a host — applies only when
 * the viewer is really inside an iframe (`isFramed`, src/lib/embed.ts).
 */
function MarkdownPreview({ node, embed = false }: { node: HandoffNode; embed?: boolean }) {
  const url = node.url ?? ''
  const [result, setResult] = useState<MdState>(null)

  useEffect(() => {
    let cancelled = false
    const base = viewerBase(node)
    const framed = embed && isFramed()
    fetchWithReauth(url)
      .then((r) => r.text())
      .then((text) => {
        if (!cancelled) {
          setResult({ url, doc: markdownDocument(renderMarkdown(text), base, { embed: framed }) })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult({
            url,
            doc: markdownDocument('<p>Failed to load Markdown.</p>', base, { embed: framed }),
          })
        }
      })
    return () => { cancelled = true }
  }, [url, node, embed])

  if (!result || result.url !== url) {
    return <div className="py-16 text-center text-sm text-muted">Loading…</div>
  }

  return (
    <iframe
      srcDoc={result.doc}
      title={node.name}
      className="h-full w-full flex-1"
      // Kill the UA default 2px inset bevel. It's especially visible when this
      // frame is itself embedded (the RSS reader iframes the chromeless viewer),
      // where the bevel reads as an ugly gray top/left border on the content.
      // The min-height only applies in embed mode, where the layout isn't
      // viewport-locked and the frame must claim its own height.
      style={{ border: 'none', ...(embed ? { minHeight: 'calc(100vh - 7.5rem)' } : null) }}
    />
  )
}

// ---------------------------------------------------------------------------
// SourceView — raw text of the underlying source, shown as escaped <pre> text
// ---------------------------------------------------------------------------

type SourceState = { url: string; text: string } | { url: string; error: true } | null

/**
 * Fetches `url` as text and renders it as escaped, monospaced, scrollable
 * source. Rendered via React text children (never `dangerouslySetInnerHTML`),
 * so hostile uploads cannot execute — even a served Site entry, which includes
 * BFFless's injected client `<script>` (ADR-0001), is shown inertly as text.
 */
function SourceView({ url }: { url: string }) {
  const [state, setState] = useState<SourceState>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchWithReauth(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((text) => {
        if (!cancelled) setState({ url, text })
      })
      .catch(() => {
        if (!cancelled) setState({ url, error: true })
      })
    return () => { cancelled = true }
  }, [url])

  // Loading while no result yet, or a result from a previous url.
  if (!state || state.url !== url) {
    return <div className="py-16 text-center text-sm text-muted">Loading source…</div>
  }

  if ('error' in state) {
    return <div className="py-16 text-center text-sm text-muted">Failed to load source.</div>
  }

  const text = state.text

  function handleCopy() {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      () => { /* clipboard unavailable — ignore */ },
    )
  }

  return (
    <div className="relative flex flex-1 flex-col">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-4 top-4 z-10 inline-flex items-center gap-1 rounded border border-border bg-surface/90 px-2 py-1 text-xs text-muted shadow-sm backdrop-blur transition-colors hover:bg-surface-2 hover:text-ink"
        title="Copy source"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-relaxed text-ink">
        <code>{text}</code>
      </pre>
    </div>
  )
}

function PreviewUnavailable({ node }: { node: HandoffNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-24">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-2 text-muted">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-8 w-8">
          <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z" clipRule="evenodd" />
          <path d="M10.748 13.93l2.523 2.523a10.003 10.003 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z" />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-ink">Preview unavailable</p>
        <p className="mt-1 text-xs text-muted">{node.name}</p>
      </div>
      {node.url && (
        <a
          href={node.url}
          download={node.name}
          className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-700"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
            <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
          </svg>
          Download
        </a>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MediaPreview — video and audio via signed URL (ADR-0001 large-media exception)
// ---------------------------------------------------------------------------

/**
 * Renders a <video> or <audio> element sourced from a freshly-minted presigned
 * GET URL. The URL is fetched via POST /api/sign on each view and is never
 * stored in redux-persist (the RTK Query cache is already excluded).
 */
function MediaPreview({ node, kind }: { node: HandoffNode; kind: 'video' | 'audio' }) {
  const storageKey = node.storageKey ?? ''
  const { data: signedUrl, isLoading, isError } = useGetSignedUrlQuery(storageKey, {
    // Skip the query if we have no key; the guard below will show the error card.
    skip: storageKey === '',
  })

  if (isLoading || (storageKey !== '' && signedUrl === undefined && !isError)) {
    return (
      <div className="flex flex-1 items-center justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent-600" />
      </div>
    )
  }

  if (isError || !signedUrl) {
    return <PreviewUnavailable node={node} />
  }

  if (kind === 'video') {
    return (
      <div className="flex flex-1 items-center justify-center bg-black p-4">
        <video
          src={signedUrl}
          controls
          className="max-h-full max-w-full"
          style={{ maxHeight: 'calc(100vh - 10rem)' }}
        />
      </div>
    )
  }

  // kind === 'audio'
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <audio src={signedUrl} controls className="w-full max-w-xl" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// ViewerBody
// ---------------------------------------------------------------------------

/**
 * Renders the file/site viewer for a resolved node `id`. Mounted by the
 * `/blob/<path>` and legacy `/view/:id` routes (`src/pages/PathPages.tsx`),
 * which own path/id resolution; this component still runs its own
 * share-token claim so it behaves correctly when reached directly (e.g. the
 * legacy route's in-place fallback render).
 */
export function ViewerBody({ id }: { id: string }) {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const embed = useEmbedMode()
  const { session, loading: sessionLoading } = useSession()
  const authed = session?.authenticated === true

  // Claim the share token first (guest only) so the gated node fetch succeeds.
  const needClaim = !sessionLoading && shouldClaimToken({ token, authenticated: authed })
  const { run: claimToken, data: claimData, isError: claimError } = useClaimShareToken()
  const claimSettled = claimData !== undefined || claimError
  const claimPending = needClaim && !claimSettled

  useEffect(() => {
    if (needClaim && token) void claimToken(token)
  }, [needClaim, token, claimToken])

  const { data: node, isLoading, isError } = useGetNodeQuery(id, {
    skip: sessionLoading || claimPending || (needClaim && claimData?.valid === false),
  })
  const contentRef = useRef<HTMLDivElement>(null)

  // Raw-source toggle. Reset to rendered whenever the viewed item changes
  // (adjust-state-during-render pattern, so opening a new item starts rendered).
  // Declared before the early returns below to keep hook order stable.
  const [showSource, setShowSource] = useState(false)
  const [prevId, setPrevId] = useState(id)
  if (id !== prevId) {
    setPrevId(id)
    setShowSource(false)
  }

  if (sessionLoading || claimPending) {
    return <div className="py-16 text-center text-sm text-muted">Loading…</div>
  }
  if (needClaim && (claimError || claimData?.valid === false)) {
    return <InvalidLink />
  }
  if (needClaim && claimData?.valid && !isLoading && (isError || !node)) return <InvalidLink />

  if (isLoading) {
    return <div className="py-16 text-center text-sm text-muted">Loading…</div>
  }

  if (isError || !node) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-muted">File not found.</p>
      </div>
    )
  }

  const kind = previewFor(node)
  const canViewSource = hasViewSource(kind) && !!node.url
  const sourceShown = canViewSource && showSource

  return (
    <div
      // Non-embed: lock the viewer to exactly the viewport below the app header
      // (3.5rem + its 1px border), so the page itself never scrolls — the
      // content region below is the single scroll context (no outer-scroll/
      // iframe-scroll fight).
      className={embed ? 'flex min-h-svh flex-col' : 'flex h-[calc(100svh-3.5rem-1px)] flex-col'}
    >
      {/* Embed mode (`?embed=1`) drops the surrounding chrome — the control bar
          with its details popover — leaving only the rendered content for inline
          iframing in an RSS reader. The share-token claim + content renderers
          below are untouched. */}
      {!embed && (
        <ControlBar
          node={node}
          contentRef={contentRef}
          canViewSource={canViewSource}
          showSource={showSource}
          onToggleSource={() => setShowSource((v) => !v)}
        />
      )}
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col overflow-auto">
        {sourceShown && node.url && (
          <SourceView url={node.url} />
        )}
        {kind === 'pdf' && node.url && (
          <iframe
            src={node.url}
            title={node.name}
            className="h-full w-full flex-1"
            style={{ border: 'none', ...(embed ? { minHeight: 'calc(100vh - 7.5rem)' } : null) }}
          />
        )}
        {kind === 'image' && node.url && (
          <div className="flex flex-1 items-center justify-center p-8">
            <img src={node.url} alt={node.name} className="max-h-full max-w-full object-contain" />
          </div>
        )}
        {!sourceShown && kind === 'markdown' && node.url && (
          <MarkdownPreview node={node} embed={embed} />
        )}
        {kind === 'video' && (
          <MediaPreview node={node} kind="video" />
        )}
        {kind === 'audio' && (
          <MediaPreview node={node} kind="audio" />
        )}
        {!sourceShown && kind === 'site' && node.url && (
          <iframe
            src={node.url}
            title={node.name}
            className="h-full w-full flex-1"
            style={{ border: 'none', ...(embed ? { minHeight: 'calc(100vh - 7.5rem)' } : null) }}
          />
        )}
        {kind === 'site' && !node.url && (
          <PreviewUnavailable node={node} />
        )}
        {kind === 'download' && (
          <PreviewUnavailable node={node} />
        )}
      </div>
    </div>
  )
}
