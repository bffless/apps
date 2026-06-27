/**
 * File viewer page for Handoff.
 *
 * Resolves a node by id via `useGetNodeQuery`, shows a sticky control bar
 * (Back, title, open-in-new-tab, fullscreen, download), and renders the
 * content region based on `previewFor(node)`.
 */

import { useRef, useState, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useGetNodeQuery, useGetSignedUrlQuery } from '../store/handoffApi'
import { previewFor, hasViewSource } from '../lib/preview'
import { renderMarkdown } from '../lib/markdown'
import type { HandoffNode } from '../lib/nodes'
import { useSession } from '../lib/session'
import { canShareParentFolder } from '../lib/shareGate'
import { ShareDialog } from '../components/ShareDialog'
import { useClaimShareToken } from '../store/useClaimShareToken'
import { InvalidLink } from '../components/InvalidLink'
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

  const isRoot = node.parentId === 'root'
  // Look up the parent folder to read its ownerId for the share gate.
  // Skip for guests (unauthenticated) to avoid a discarded 401 on the parent fetch.
  const { data: parentNode } = useGetNodeQuery(node.parentId, { skip: isRoot || !(session?.authenticated) })
  const canShare = canShareParentFolder({ session, parentNode: parentNode ?? undefined })

  const [shareOpen, setShareOpen] = useState(false)

  function handleFullscreen() {
    if (contentRef.current) {
      contentRef.current.requestFullscreen().catch(() => { /* ignore */ })
    }
  }

  return (
    <div
      className="sticky top-14 flex items-center gap-2 border-b border-border bg-surface/90 px-4 py-2 backdrop-blur"
      style={{ zIndex: 'var(--z-sticky)' }}
    >
      {/* Back */}
      <button
        type="button"
        onClick={() => navigate('/')}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-muted no-underline transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
        </svg>
        Back
      </button>

      {/* Title */}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{node.name}</span>

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
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-muted no-underline transition-colors hover:bg-surface-2 hover:text-ink"
          title={showSource ? 'View rendered' : 'View source'}
          aria-pressed={showSource}
        >
          <CodeIcon />
          <span className="hidden sm:inline">{showSource ? 'View rendered' : 'View source'}</span>
        </button>
      )}

      {/* Open in new tab */}
      {node.url && (
        <a
          href={node.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-muted no-underline transition-colors hover:bg-surface-2 hover:text-ink"
          title="Open in new tab"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path fillRule="evenodd" d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" clipRule="evenodd" />
            <path fillRule="evenodd" d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z" clipRule="evenodd" />
          </svg>
          <span className="hidden sm:inline">Open</span>
        </a>
      )}

      {/* Fullscreen */}
      <button
        type="button"
        onClick={handleFullscreen}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-muted no-underline transition-colors hover:bg-surface-2 hover:text-ink"
        title="Fullscreen"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path d="M13.28 7.78a.75.75 0 0 0-1.06-1.06l-1.97 1.97V5.75a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 .75.75h4.5a.75.75 0 0 0 0-1.5h-2.94l1.97-1.97ZM6.72 12.22a.75.75 0 0 0 1.06 1.06l1.97-1.97v2.94a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.94l-1.97 1.97Z" />
        </svg>
        <span className="hidden sm:inline">Fullscreen</span>
      </button>

      {/* Download — not shown for sites (use Open-in-new-tab instead) */}
      {node.url && node.type !== 'site' && (
        <a
          href={node.url}
          download={node.name}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-muted no-underline transition-colors hover:bg-surface-2 hover:text-ink"
          title="Download"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
            <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
          </svg>
          <span className="hidden sm:inline">Download</span>
        </a>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Content renderers
// ---------------------------------------------------------------------------

type MdState = { url: string; html: string } | null

function MarkdownPreview({ url }: { url: string }) {
  const [result, setResult] = useState<MdState>(null)

  useEffect(() => {
    let cancelled = false
    fetch(url)
      .then((r) => r.text())
      .then((text) => {
        if (!cancelled) setResult({ url, html: renderMarkdown(text) })
      })
      .catch(() => {
        if (!cancelled) setResult({ url, html: '<p>Failed to load Markdown.</p>' })
      })
    return () => { cancelled = true }
  }, [url])

  if (!result || result.url !== url) {
    return <div className="py-16 text-center text-sm text-muted">Loading…</div>
  }

  return (
    <div
      className="markdown-body mx-auto max-w-3xl px-4 py-8 leading-relaxed text-ink"
      dangerouslySetInnerHTML={{ __html: result.html }}
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
    fetch(url)
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
// HandoffViewer
// ---------------------------------------------------------------------------

export function HandoffViewer() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
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

  const { data: node, isLoading, isError } = useGetNodeQuery(id ?? '', {
    skip: !id || sessionLoading || claimPending || (needClaim && claimData?.valid === false),
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
    <div className="flex flex-col" style={{ minHeight: 'calc(100vh - 3.5rem)' }}>
      <ControlBar
        node={node}
        contentRef={contentRef}
        canViewSource={canViewSource}
        showSource={showSource}
        onToggleSource={() => setShowSource((v) => !v)}
      />
      <div ref={contentRef} className="flex flex-1 flex-col overflow-auto">
        {sourceShown && node.url && (
          <SourceView url={node.url} />
        )}
        {kind === 'pdf' && node.url && (
          <iframe
            src={node.url}
            title={node.name}
            className="h-full w-full flex-1"
            style={{ minHeight: 'calc(100vh - 7.5rem)' }}
          />
        )}
        {kind === 'image' && node.url && (
          <div className="flex flex-1 items-center justify-center p-8">
            <img src={node.url} alt={node.name} className="max-h-full max-w-full object-contain" />
          </div>
        )}
        {!sourceShown && kind === 'markdown' && node.url && (
          <MarkdownPreview url={node.url} />
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
            style={{ minHeight: 'calc(100vh - 7.5rem)' }}
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
