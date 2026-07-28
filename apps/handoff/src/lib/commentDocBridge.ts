/**
 * Same-origin iframe bridge for viewer margin comments (spec §3).
 *
 * This is the ONE module that touches `iframe.contentDocument`. Everything the
 * viewer renders is same-origin (ADR-0001), so the parent frame reads the inner
 * document directly — no script injection, no postMessage protocol. The bridge:
 *
 *   - resolves stored text anchors against the live document (read-only: stored
 *     anchors are never rewritten) and reports their document-space y positions
 *     so the gutter can align cards;
 *   - paints highlights with the CSS Custom Highlight API, guarded for absence
 *     (jsdom, older browsers) — cards still align when highlights are missing;
 *   - emits the user's text selection so a new comment can be composed;
 *   - re-measures on scroll/resize and, debounced, when a Site's own JS mutates
 *     the DOM (best-effort re-anchoring).
 *
 * `detach()` must undo everything: listeners, observer, timers, the highlight
 * registry entries and the injected <style>.
 */
import {
  anchorFromRange, buildTextIndex, rangeFromSpan, resolveTextAnchor, type TextIndex,
} from './commentAnchors'
import type { CommentAnchorText } from './comments'

/** Document-space vertical position of a resolved anchor. */
export interface AnchoredPosition {
  id: string
  y: number
}

export interface SelectionInfo {
  anchor: CommentAnchorText
  /** Document-space (scroll-independent) rect of the selection. */
  rect: { top: number; left: number; bottom: number }
}

export interface BridgeGeometry {
  positions: AnchoredPosition[]
  /** Ids whose anchor no longer resolves against the current document text. */
  unresolved: string[]
  scrollTop: number
  docHeight: number
  viewportHeight: number
}

export interface BridgeCallbacks {
  /** Fired on scroll/resize/mutation with fresh geometry. */
  onGeometry(g: BridgeGeometry): void
  /** Fired when the user finishes a non-collapsed selection; null when cleared. */
  onSelection(sel: SelectionInfo | null): void
}

export interface CommentDocBridge {
  setAnchors(anchors: { id: string; anchor: CommentAnchorText }[]): void
  /** Repaints the active highlight. */
  setActive(id: string | null): void
  /** Smooth-scrolls the iframe document to the anchor. */
  scrollToAnchor(id: string): void
  clearSelection(): void
  detach(): void
}

type HighlightCtor = new (...ranges: Range[]) => unknown
type HighlightRegistry = {
  set(name: string, highlight: unknown): void
  delete(name: string): void
}

/**
 * The slice of `Window` the bridge needs. A real (same-origin) `Window`
 * satisfies it; tests pass a stub so listener wiring is observable.
 */
export type BridgeWindow = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  CSS?: unknown
  Highlight?: unknown
  innerHeight?: number
  requestAnimationFrame?: (cb: FrameRequestCallback) => number
  cancelAnimationFrame?: (handle: number) => void
  MutationObserver?: typeof MutationObserver
}

const HIGHLIGHT_ALL = 'hf-comment'
const HIGHLIGHT_ACTIVE = 'hf-comment-active'
const STYLE_MARKER = 'data-hf-comments'
const HIGHLIGHT_CSS = `::highlight(${HIGHLIGHT_ALL}) { background: rgba(250, 204, 21, 0.30); }
::highlight(${HIGHLIGHT_ACTIVE}) { background: rgba(250, 204, 21, 0.60); }`
const MUTATION_DEBOUNCE_MS = 250
const FRAME_FALLBACK_MS = 16

export function attachCommentBridge(
  iframe: HTMLIFrameElement, cb: BridgeCallbacks,
): CommentDocBridge | null {
  const doc = iframe.contentDocument
  const win = iframe.contentWindow
  // Caller retries on the iframe's `load` event.
  if (!doc || !win || doc.readyState === 'loading') return null
  return createDocBridge(doc, win as unknown as BridgeWindow, cb)
}

export function createDocBridge(
  doc: Document, win: BridgeWindow, cb: BridgeCallbacks,
): CommentDocBridge {
  let entries: { id: string; anchor: CommentAnchorText }[] = []
  let activeId: string | null = null
  let index: TextIndex | null = null
  let detached = false

  let frame: number | null = null
  let frameIsTimeout = false
  let mutationTimer: ReturnType<typeof setTimeout> | null = null

  // --- text index -----------------------------------------------------------

  function getIndex(): TextIndex {
    if (!index) index = buildTextIndex(doc.body ?? doc)
    return index
  }

  function rangeFor(anchor: CommentAnchorText): Range | null {
    const idx = getIndex()
    const span = resolveTextAnchor(idx.text, anchor)
    if (!span) return null
    return rangeFromSpan(idx, span.start, span.end, doc)
  }

  function scrollTopOf(): number {
    return doc.documentElement?.scrollTop || doc.body?.scrollTop || 0
  }

  // --- highlights -----------------------------------------------------------

  function highlightApi(): { Highlight: HighlightCtor; registry: HighlightRegistry } | null {
    const Highlight = (win as { Highlight?: HighlightCtor }).Highlight
    const registry = (win.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights
    if (typeof Highlight !== 'function' || !registry) return null
    return { Highlight, registry }
  }

  function paint(ranges: Range[], activeRange: Range | null) {
    const api = highlightApi()
    if (!api) return // jsdom / older browsers: cards still align, just no highlight
    try {
      api.registry.set(HIGHLIGHT_ALL, new api.Highlight(...ranges))
      api.registry.set(
        HIGHLIGHT_ACTIVE,
        activeRange ? new api.Highlight(activeRange) : new api.Highlight(),
      )
    } catch {
      /* a stale Range can throw — highlights are decoration, never fatal */
    }
  }

  const style = doc.createElement('style')
  style.setAttribute(STYLE_MARKER, '')
  style.textContent = HIGHLIGHT_CSS
  doc.head?.appendChild(style)

  // --- measurement ----------------------------------------------------------

  function report() {
    if (detached) return
    const scrollTop = scrollTopOf()
    const positions: AnchoredPosition[] = []
    const unresolved: string[] = []
    const ranges: Range[] = []
    let activeRange: Range | null = null

    for (const { id, anchor } of entries) {
      const range = rangeFor(anchor)
      if (!range) {
        unresolved.push(id)
        continue
      }
      const rect = range.getBoundingClientRect()
      positions.push({ id, y: rect.top + scrollTop })
      ranges.push(range)
      if (id === activeId) activeRange = range
    }

    paint(ranges, activeRange)
    cb.onGeometry({
      positions,
      unresolved,
      scrollTop,
      docHeight: doc.documentElement?.scrollHeight ?? 0,
      viewportHeight: win.innerHeight ?? doc.documentElement?.clientHeight ?? 0,
    })
  }

  /** rAF-throttled measurement; jsdom/exotic windows fall back to a timer. */
  function schedule() {
    if (detached || frame !== null) return
    const raf = win.requestAnimationFrame
    if (typeof raf === 'function') {
      frameIsTimeout = false
      frame = raf.call(win, () => { frame = null; report() })
    } else {
      frameIsTimeout = true
      frame = setTimeout(() => { frame = null; report() }, FRAME_FALLBACK_MS) as unknown as number
    }
  }

  function cancelFrame() {
    if (frame === null) return
    if (frameIsTimeout) clearTimeout(frame as unknown as ReturnType<typeof setTimeout>)
    else win.cancelAnimationFrame?.(frame)
    frame = null
  }

  // --- selection ------------------------------------------------------------

  function emitSelection() {
    if (detached) return
    const sel = doc.getSelection?.()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      cb.onSelection(null)
      return
    }
    const range = sel.getRangeAt(0)
    const anchor = anchorFromRange(getIndex(), range)
    if (!anchor) {
      cb.onSelection(null)
      return
    }
    const rect = range.getBoundingClientRect()
    const scrollTop = scrollTopOf()
    cb.onSelection({
      anchor,
      rect: { top: rect.top + scrollTop, left: rect.left, bottom: rect.bottom + scrollTop },
    })
  }

  /** Collapsing the selection (a plain click) clears any pending composer. */
  function onSelectionChange() {
    if (detached) return
    const sel = doc.getSelection?.()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) cb.onSelection(null)
  }

  // --- listeners ------------------------------------------------------------

  const docListeners: [string, EventListener, AddEventListenerOptions | undefined][] = [
    // Capture also catches a Site's own inner scroll containers.
    ['scroll', schedule as EventListener, { passive: true, capture: true }],
    ['selectionchange', onSelectionChange as EventListener, undefined],
    ['mouseup', emitSelection as EventListener, undefined],
    ['keyup', emitSelection as EventListener, undefined],
  ]
  for (const [type, fn, opts] of docListeners) doc.addEventListener(type, fn, opts)

  const onResize: EventListener = () => schedule()
  win.addEventListener('resize', onResize)

  // --- mutations ------------------------------------------------------------

  const MO = win.MutationObserver
    ?? (typeof MutationObserver !== 'undefined' ? MutationObserver : undefined)
  const observer = MO
    ? new MO(() => {
        if (mutationTimer) clearTimeout(mutationTimer)
        mutationTimer = setTimeout(() => {
          mutationTimer = null
          index = null // the Site's JS changed the DOM: re-anchor best-effort
          schedule()
        }, MUTATION_DEBOUNCE_MS)
      })
    : null
  if (observer && doc.body) {
    observer.observe(doc.body, { subtree: true, childList: true, characterData: true })
  }

  // Give the consumer an initial docHeight/viewportHeight before any anchors.
  schedule()

  return {
    setAnchors(next) {
      entries = next
      schedule()
    },
    setActive(id) {
      activeId = id
      schedule()
    },
    scrollToAnchor(id) {
      const entry = entries.find((e) => e.id === id)
      if (!entry) return
      const range = rangeFor(entry.anchor)
      range?.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
    clearSelection() {
      doc.getSelection?.()?.removeAllRanges()
    },
    detach() {
      if (detached) return
      detached = true
      for (const [type, fn, opts] of docListeners) doc.removeEventListener(type, fn, opts)
      win.removeEventListener('resize', onResize)
      observer?.disconnect()
      if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null }
      cancelFrame()
      const api = highlightApi()
      api?.registry.delete(HIGHLIGHT_ALL)
      api?.registry.delete(HIGHLIGHT_ACTIVE)
      style.remove()
    },
  }
}
