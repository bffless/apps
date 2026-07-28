/**
 * CommentLayer — the one component that turns the comment pieces into the
 * feature (spec §5). It owns every bit of viewer-side comment state so the
 * viewer itself stays a renderer:
 *
 *   - the comment list (polled while the gutter is open, so a teammate's note
 *     arrives without a refresh);
 *   - the iframe bridge for markdown/site — where anchors resolve to document
 *     Ys, highlights get painted, and the reader's selection comes back;
 *   - the pin overlay for images, which needs no bridge at all (an image has
 *     one static "document", so geometry is synthesized with `scrollTop: 0`);
 *   - the draft (a not-yet-posted comment) and which thread is active.
 *
 * Two coordinate systems meet, as in `CommentPanel`: the bridge reports
 * *document* space (scroll-independent), which is what the gutter canvas wants,
 * while the floating "Comment" bubble has to sit over the real selection on
 * screen — so it converts to viewport space (`iframe box + docY − scrollTop`)
 * and is `position: fixed`, which is also what keeps it correct inside the
 * Fullscreen subtree.
 *
 * Bridge lifecycle is the fiddly part. `attachCommentBridge` returns null while
 * the inner document is still loading, and `MarkdownPreview` doesn't even mount
 * its iframe until the fetch resolves — so attachment retries (capped), and the
 * iframe's `load` event both retries and *re-*attaches, because a srcDoc swap
 * replaces the document the old bridge was bound to. `detach()` is the only
 * thing that removes the highlight registry entries and the injected <style>,
 * so it runs on every teardown without exception.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  attachCommentBridge,
  type BridgeGeometry,
  type CommentDocBridge,
  type SelectionInfo,
} from '../../lib/commentDocBridge'
import type {
  CommentAnchor,
  CommentAnchorPin,
  CommentAnchorText,
  CommentThread,
} from '../../lib/comments'
import { threadsFor } from '../../lib/comments'
import type { HandoffNode } from '../../lib/nodes'
import { useListCommentsQuery } from '../../store/handoffApi'
import { CommentPanel } from './CommentPanel'
import { ImagePinLayer, renderedImageRect } from './ImagePinLayer'

/** Comment kinds the viewer supports. PDFs and media are a spec non-goal. */
export type CommentKind = 'markdown' | 'site' | 'image'

/** Teammates' comments land within this long — cheap enough for one document. */
const POLL_MS = 20000

/** Attachment retries while the inner document is still coming up. */
const ATTACH_RETRY_MS = 150
const MAX_ATTACH_ATTEMPTS = 20

/** Approximate bubble size, used only to keep it clamped inside the iframe. */
const BUBBLE_H = 32
const BUBBLE_W = 120

export interface CommentLayerProps {
  node: HandoffNode
  kind: CommentKind
  /** The markdown/site content iframe. Unused for images. */
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  /** The rendered image. Unused for markdown/site. */
  imgRef: React.RefObject<HTMLImageElement | null>
  /**
   * The element the pin overlay is portalled into — the positioned wrapper
   * around the image, whose origin is the image's own box (`ImagePinLayer`
   * measures in that space). Null for non-image kinds.
   */
  pinHost?: HTMLElement | null
  open: boolean
  canWrite: boolean
}

/** Roots carrying a text anchor, in bridge order. */
function textAnchorsOf(threads: CommentThread[]): { id: string; anchor: CommentAnchorText }[] {
  const out: { id: string; anchor: CommentAnchorText }[] = []
  for (const t of threads) {
    const a = t.root.anchor
    if (a?.type === 'text' && !t.root.deleted) out.push({ id: t.root.id, anchor: a })
  }
  return out
}

export function CommentLayer({
  node,
  kind,
  iframeRef,
  imgRef,
  pinHost,
  open,
  canWrite,
}: CommentLayerProps) {
  const { data: comments } = useListCommentsQuery(
    { nodeId: node.id },
    { pollingInterval: POLL_MS },
  )
  const threads = useMemo(() => threadsFor(comments ?? []), [comments])

  const [geometry, setGeometry] = useState<BridgeGeometry | null>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [draft, setDraft] = useState<{ anchor: CommentAnchor; anchorY: number } | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)

  const bridgeRef = useRef<CommentDocBridge | null>(null)
  // Bumped when a bridge is (re)attached, so the anchor/active effects below
  // re-run against the new one.
  const [bridgeGen, setBridgeGen] = useState(0)

  // The iframe's own viewport box — the offset that turns the bridge's
  // document-space rects into screen positions for the bubble. Captured inside
  // the bridge callbacks (never during render, where a ref is off limits), and
  // only replaced when it really moved, so a scroll doesn't re-render the
  // gutter for nothing.
  const [iframeBox, setIframeBox] = useState<DOMRect | null>(null)
  const captureBox = useCallback(() => {
    const box = iframeRef.current?.getBoundingClientRect() ?? null
    setIframeBox((prev) =>
      prev && box && prev.top === box.top && prev.left === box.left
      && prev.right === box.right && prev.bottom === box.bottom
        ? prev
        : box,
    )
  }, [iframeRef])

  const onGeometry = useCallback((g: BridgeGeometry) => {
    setGeometry(g)
    captureBox()
  }, [captureBox])
  // `clearSelection()` comes back asynchronously as a real selectionchange, so
  // this legitimately fires with null right after a draft opens — which simply
  // hides the bubble. The draft is separate state and survives it.
  const onSelection = useCallback((s: SelectionInfo | null) => {
    setSelection(s)
    captureBox()
  }, [captureBox])

  // --- Bridge attach / re-attach / detach ----------------------------------

  const usesBridge = kind === 'markdown' || kind === 'site'
  useEffect(() => {
    if (!usesBridge) return
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let listening: HTMLIFrameElement | null = null

    const drop = () => {
      bridgeRef.current?.detach()
      bridgeRef.current = null
    }

    const schedule = (ms: number) => {
      if (cancelled || timer !== null) return
      timer = setTimeout(attempt, ms)
    }

    function attempt() {
      timer = null
      if (cancelled || bridgeRef.current) return
      const iframe = iframeRef.current
      if (iframe && listening !== iframe) {
        listening?.removeEventListener('load', onLoad)
        iframe.addEventListener('load', onLoad)
        listening = iframe
      }
      const bridge = iframe ? attachCommentBridge(iframe, { onGeometry, onSelection }) : null
      if (bridge) {
        bridgeRef.current = bridge
        setBridgeGen((g) => g + 1)
        return
      }
      // Still loading (or the iframe hasn't mounted yet — MarkdownPreview only
      // renders it once the fetch resolves). Try again, but never forever.
      if (++attempts < MAX_ATTACH_ATTEMPTS) schedule(ATTACH_RETRY_MS)
    }

    /** A srcDoc/src swap replaced the document the old bridge was bound to. */
    function onLoad() {
      drop()
      setGeometry(null)
      attempts = 0
      schedule(0)
    }

    attempt()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      listening?.removeEventListener('load', onLoad)
      // Only detach() clears the highlight registry + the injected <style>.
      drop()
    }
  }, [usesBridge, iframeRef, node.id, onGeometry, onSelection])

  // Feed the bridge its anchors — but only when the anchor set actually
  // changed. A blanket call on every render (polling alone re-creates the
  // comment array every 20s) would clear the bridge's per-generation span memo
  // and put the expensive fuzzy re-anchor back on the hot path.
  const anchorSig = useMemo(
    () => textAnchorsOf(threads).map((a) => `${a.id}@${a.anchor.start}-${a.anchor.end}`).join('|'),
    [threads],
  )
  // Keyed by bridge generation as well as content: a re-attached bridge starts
  // with no anchors, so an unchanged signature must not skip the first send.
  const lastAnchors = useRef<{ gen: number; sig: string } | null>(null)
  useEffect(() => {
    const bridge = bridgeRef.current
    if (!bridge) return
    const last = lastAnchors.current
    if (last && last.gen === bridgeGen && last.sig === anchorSig) return
    lastAnchors.current = { gen: bridgeGen, sig: anchorSig }
    bridge.setAnchors(textAnchorsOf(threads))
  }, [anchorSig, threads, bridgeGen])

  useEffect(() => {
    bridgeRef.current?.setActive(activeId)
  }, [activeId, bridgeGen])

  // --- Image geometry ------------------------------------------------------
  // No bridge: an image is one static "document". The overlay rect is measured
  // in the image's own box (what ImagePinLayer positions against); `offsetTop`
  // lifts it into the gutter's document space, whose origin is this column's
  // top — the two are siblings in the content row.

  const rootRef = useRef<HTMLDivElement>(null)
  const [imgBox, setImgBox] = useState({
    left: 0, top: 0, width: 0, height: 0, offsetTop: 0, columnHeight: 0,
  })

  useEffect(() => {
    if (kind !== 'image') return
    const img = imgRef.current
    const measure = () => {
      const el = imgRef.current
      if (!el) return
      const rect = renderedImageRect(
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: el.naturalWidth, height: el.naturalHeight },
      )
      const root = rootRef.current
      const rootTop = root?.getBoundingClientRect().top ?? 0
      setImgBox({
        ...rect,
        offsetTop: el.getBoundingClientRect().top - rootTop,
        columnHeight: root?.offsetHeight ?? 0,
      })
    }
    measure()
    img?.addEventListener('load', measure)
    let observer: ResizeObserver | undefined
    if (img && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(img)
    }
    window.addEventListener('resize', measure)
    return () => {
      img?.removeEventListener('load', measure)
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [kind, imgRef])

  // --- Positions fed to the gutter -----------------------------------------

  /** Every placed pin — including resolved ones, so their cards still align
      when "Show resolved" is on rather than falling into Unanchored. */
  const pinned = useMemo(() => {
    const out: { id: string; pin: CommentAnchorPin; resolved: boolean }[] = []
    for (const t of threads) {
      const a = t.root.anchor
      if (a?.type === 'pin' && !t.root.deleted) {
        out.push({ id: t.root.id, pin: a, resolved: t.root.resolved })
      }
    }
    return out
  }, [threads])

  /** Dots on the image: open threads only, numbered as the reader sees them. */
  const pins = useMemo(
    () => pinned.filter((p) => !p.resolved).map((p, i) => ({ id: p.id, pin: p.pin, n: i + 1 })),
    [pinned],
  )

  const positions = useMemo(() => {
    // Never null: while the bridge is still measuring, an EMPTY map says
    // "nothing placed *yet*", and the panel's Unanchored rail is the honest
    // fallback for exactly that window.
    const map = new Map<string, number>()
    if (kind === 'image') {
      for (const { id, pin } of pinned) {
        map.set(id, imgBox.offsetTop + imgBox.top + pin.y * imgBox.height)
      }
      return map
    }
    for (const p of geometry?.positions ?? []) map.set(p.id, p.y)
    return map
  }, [kind, pinned, imgBox, geometry])

  const scrollTop = kind === 'image' ? 0 : (geometry?.scrollTop ?? 0)
  const docHeight = kind === 'image' ? imgBox.columnHeight : (geometry?.docHeight ?? 0)

  // --- Selection bubble ----------------------------------------------------
  // The bubble sits over the live selection, so it works in *viewport* space:
  // document Y − scrollTop, offset by the iframe's own box and clamped inside
  // it. `fixed` positioning is what keeps it right inside the Fullscreen
  // subtree too. Pure math over measured state — no ref reads during render.
  const bubble = useMemo(() => {
    if (!canWrite || !selection || draft || !iframeBox) return null
    const y = iframeBox.top + selection.rect.bottom - (geometry?.scrollTop ?? 0)
    return {
      top: Math.min(
        Math.max(y, iframeBox.top),
        Math.max(iframeBox.bottom - BUBBLE_H, iframeBox.top),
      ),
      left: Math.min(
        Math.max(iframeBox.left + selection.rect.left, iframeBox.left),
        Math.max(iframeBox.right - BUBBLE_W, iframeBox.left),
      ),
    }
  }, [canWrite, selection, draft, iframeBox, geometry])

  // --- Draft ---------------------------------------------------------------

  const startDraft = useCallback((anchor: CommentAnchor, anchorY: number) => {
    if (!canWrite) return // never open a composer a visitor can't use
    setDraft({ anchor, anchorY })
    setActiveId(null)
  }, [canWrite])

  function commentOnSelection() {
    if (!selection) return
    startDraft(selection.anchor, selection.rect.top)
    // Fires onSelection(null) asynchronously — see the callback's note.
    bridgeRef.current?.clearSelection()
    setSelection(null)
  }

  function placePin(pin: CommentAnchorPin) {
    startDraft(pin, imgBox.offsetTop + imgBox.top + pin.y * imgBox.height)
  }

  const activate = useCallback((id: string | null) => {
    setActiveId(id)
    if (id) bridgeRef.current?.scrollToAnchor(id)
  }, [])

  const onDraftDone = useCallback((createdId?: string) => {
    setDraft(null)
    if (createdId) setActiveId(createdId)
  }, [])

  if (!open) return null

  return (
    <div ref={rootRef} className="flex shrink-0">
      {bubble && (
        <button
          type="button"
          onClick={commentOnSelection}
          style={{ top: bubble.top, left: bubble.left, zIndex: 'var(--z-sticky)' }}
          className="fixed inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-ink shadow-md transition-colors hover:bg-surface-2"
        >
          <span aria-hidden="true">＋</span> Comment
        </button>
      )}

      {kind === 'image' && pinHost
        ? createPortal(
            <ImagePinLayer
              imgRef={imgRef}
              pins={pins}
              activeId={activeId}
              canWrite={canWrite}
              onActivate={activate}
              onPlacePin={placePin}
            />,
            pinHost,
          )
        : null}

      <CommentPanel
        nodeId={node.id}
        threads={threads}
        positions={positions}
        scrollTop={scrollTop}
        docHeight={docHeight}
        activeId={activeId}
        onActivate={activate}
        canWrite={canWrite}
        draft={draft}
        onDraftDone={onDraftDone}
      />
    </div>
  )
}
