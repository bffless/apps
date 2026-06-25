/**
 * File viewer page for Handoff.
 *
 * Resolves a node by id via `useGetNodeQuery`, shows a sticky control bar
 * (Back, title, open-in-new-tab, fullscreen, download), and renders the
 * content region based on `previewFor(node)`.
 */

import { useRef, useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useGetNodeQuery, useGetSignedUrlQuery } from '../store/handoffApi'
import { previewFor } from '../lib/preview'
import { renderMarkdown } from '../lib/markdown'
import type { HandoffNode } from '../lib/nodes'

// ---------------------------------------------------------------------------
// Control bar
// ---------------------------------------------------------------------------

interface ControlBarProps {
  node: HandoffNode
  contentRef: React.RefObject<HTMLDivElement | null>
}

function ControlBar({ node, contentRef }: ControlBarProps) {
  const navigate = useNavigate()

  function handleFullscreen() {
    if (contentRef.current) {
      contentRef.current.requestFullscreen().catch(() => { /* ignore */ })
    }
  }

  return (
    <div className="sticky top-14 z-30 flex items-center gap-2 border-b border-gray-200 bg-white/90 px-4 py-2 backdrop-blur">
      {/* Back */}
      <button
        type="button"
        onClick={() => navigate('/')}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path fillRule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" />
        </svg>
        Back
      </button>

      {/* Title */}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">{node.name}</span>

      {/* Open in new tab */}
      {node.url && (
        <a
          href={node.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
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
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
        title="Fullscreen"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path d="M13.28 7.78a.75.75 0 0 0-1.06-1.06l-1.97 1.97V5.75a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 .75.75h4.5a.75.75 0 0 0 0-1.5h-2.94l1.97-1.97ZM6.72 12.22a.75.75 0 0 0 1.06 1.06l1.97-1.97v2.94a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.94l-1.97 1.97Z" />
        </svg>
        <span className="hidden sm:inline">Fullscreen</span>
      </button>

      {/* Download */}
      {node.url && (
        <a
          href={node.url}
          download={node.name}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
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
    return <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
  }

  return (
    <div
      className="prose prose-gray mx-auto max-w-3xl px-4 py-8"
      dangerouslySetInnerHTML={{ __html: result.html }}
    />
  )
}

function PreviewUnavailable({ node }: { node: HandoffNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-24">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-gray-400">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-8 w-8">
          <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z" clipRule="evenodd" />
          <path d="M10.748 13.93l2.523 2.523a10.003 10.003 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z" />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-gray-700">Preview unavailable</p>
        <p className="mt-1 text-xs text-gray-400">{node.name}</p>
      </div>
      {node.url && (
        <a
          href={node.url}
          download={node.name}
          className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
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
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
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
  const { data: node, isLoading, isError } = useGetNodeQuery(id ?? '')
  const contentRef = useRef<HTMLDivElement>(null)

  if (isLoading) {
    return <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
  }

  if (isError || !node) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-gray-500">File not found.</p>
      </div>
    )
  }

  const kind = previewFor(node)

  return (
    <div className="flex flex-col" style={{ minHeight: 'calc(100vh - 3.5rem)' }}>
      <ControlBar node={node} contentRef={contentRef} />
      <div ref={contentRef} className="flex flex-1 flex-col overflow-auto">
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
        {kind === 'markdown' && node.url && (
          <MarkdownPreview url={node.url} />
        )}
        {kind === 'video' && (
          <MediaPreview node={node} kind="video" />
        )}
        {kind === 'audio' && (
          <MediaPreview node={node} kind="audio" />
        )}
        {(kind === 'site' || kind === 'download') && (
          <PreviewUnavailable node={node} />
        )}
      </div>
    </div>
  )
}
