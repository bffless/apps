import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { attachCommentBridge, createDocBridge } from './commentDocBridge'
import type { BridgeCallbacks, BridgeWindow, CommentDocBridge } from './commentDocBridge'
import type { CommentAnchorText } from './comments'

// Count real calls into the resolution path (pass-through wrapper, no behaviour change)
// so the per-generation memoization can be pinned.
const hoisted = vi.hoisted(() => ({ resolveCalls: 0 }))
vi.mock('./commentAnchors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./commentAnchors')>()
  return {
    ...actual,
    resolveTextAnchor: (text: string, anchor: CommentAnchorText) => {
      hoisted.resolveCalls++
      return actual.resolveTextAnchor(text, anchor)
    },
  }
})

const HTML =
  '<p id="p1">The quick brown fox jumps over the lazy dog.</p>' +
  '<p id="p2">Second paragraph with more words.</p>'

const anchorA: CommentAnchorText = {
  type: 'text', quote: 'brown fox', prefix: 'The quick ', suffix: ' jumps over',
  start: 10, end: 19,
}
const anchorDead: CommentAnchorText = {
  type: 'text', quote: 'nonexistent phrase', prefix: '', suffix: '', start: 0, end: 18,
}

function makeWin(extra: Partial<BridgeWindow> = {}) {
  const frames: FrameRequestCallback[] = []
  const spies = {
    add: vi.fn<(type: string, listener: EventListener) => void>(),
    remove: vi.fn<(type: string, listener: EventListener) => void>(),
    cancelRaf: vi.fn<(handle: number) => void>(),
  }
  const win = {
    addEventListener: spies.add,
    removeEventListener: spies.remove,
    innerHeight: 600,
    requestAnimationFrame: (fn: FrameRequestCallback) => { frames.push(fn); return frames.length },
    cancelAnimationFrame: spies.cancelRaf,
    ...extra,
  } as unknown as BridgeWindow
  const flush = () => { for (const fn of frames.splice(0)) fn(0) }
  return { win, flush, frames, spies }
}

function makeCallbacks() {
  return { onGeometry: vi.fn(), onSelection: vi.fn() } satisfies BridgeCallbacks
}

// jsdom has no layout, so Range.getBoundingClientRect does not exist at all.
// Define a zero-rect stand-in so tests can spy on it with real rects.
if (!('getBoundingClientRect' in Range.prototype)) {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    value: () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0 }),
    writable: true,
    configurable: true,
  })
}

let bridges: CommentDocBridge[] = []
function attach(doc: Document, win: BridgeWindow, cb: BridgeCallbacks) {
  const b = createDocBridge(doc, win, cb)
  bridges.push(b)
  return b
}

beforeEach(() => {
  hoisted.resolveCalls = 0
  document.body.innerHTML = HTML
  Object.defineProperty(document.documentElement, 'scrollTop', {
    value: 40, configurable: true, writable: true,
  })
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    value: 2000, configurable: true, writable: true,
  })
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 100, left: 5, bottom: 120, right: 55, width: 50, height: 20, x: 5, y: 100,
    toJSON: () => ({}),
  } as DOMRect)
})

afterEach(() => {
  for (const b of bridges) b.detach()
  bridges = []
  document.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('createDocBridge geometry', () => {
  it('reports document-space positions and unresolved ids for setAnchors', () => {
    const { win, flush } = makeWin()
    const cb = makeCallbacks()
    const bridge = attach(document, win, cb)
    cb.onGeometry.mockClear()

    bridge.setAnchors([{ id: 'a', anchor: anchorA }, { id: 'dead', anchor: anchorDead }])
    flush()

    expect(cb.onGeometry).toHaveBeenCalledTimes(1)
    expect(cb.onGeometry.mock.calls[0][0]).toEqual({
      positions: [{ id: 'a', y: 140 }], // rect.top (100) + scrollTop (40)
      unresolved: ['dead'],
      scrollTop: 40,
      docHeight: 2000,
      viewportHeight: 600,
    })
  })

  it('throttles multiple triggers into a single frame', () => {
    const { win, flush } = makeWin()
    const cb = makeCallbacks()
    const bridge = attach(document, win, cb)
    flush()
    cb.onGeometry.mockClear()

    bridge.setAnchors([{ id: 'a', anchor: anchorA }])
    bridge.setActive('a')
    bridge.setActive(null)
    flush()

    expect(cb.onGeometry).toHaveBeenCalledTimes(1)
  })

  it('re-measures on scroll and resize', () => {
    const { win, flush, spies } = makeWin()
    const cb = makeCallbacks()
    attach(document, win, cb)
    flush()
    cb.onGeometry.mockClear()

    document.dispatchEvent(new Event('scroll'))
    flush()
    expect(cb.onGeometry).toHaveBeenCalledTimes(1)

    const resize = spies.add.mock.calls.find((c) => c[0] === 'resize')
    expect(resize).toBeTruthy()
    resize![1](new Event('resize'))
    flush()
    expect(cb.onGeometry).toHaveBeenCalledTimes(2)
  })

  it('falls back to setTimeout when the window has no requestAnimationFrame', () => {
    vi.useFakeTimers()
    const { win } = makeWin({ requestAnimationFrame: undefined })
    const cb = makeCallbacks()
    const bridge = attach(document, win, cb)
    bridge.setAnchors([{ id: 'a', anchor: anchorA }])
    expect(cb.onGeometry).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(cb.onGeometry).toHaveBeenCalled()
  })
})

describe('createDocBridge selection', () => {
  function selectQuickBrown() {
    const text = document.getElementById('p1')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 4)
    range.setEnd(text, 15) // 'quick brown'
    const sel = document.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  it('emits the anchor for a non-collapsed selection on mouseup', () => {
    const { win } = makeWin()
    const cb = makeCallbacks()
    attach(document, win, cb)

    selectQuickBrown()
    document.dispatchEvent(new MouseEvent('mouseup'))

    expect(cb.onSelection).toHaveBeenCalled()
    const info = cb.onSelection.mock.calls.at(-1)![0]
    expect(info.anchor.quote).toBe('quick brown')
    expect(info.anchor.prefix).toBe('The ')
    expect(info.anchor.start).toBe(4)
    expect(info.rect).toEqual({ top: 140, left: 5, bottom: 160 }) // doc-space
  })

  it('emits null when the selection collapses', () => {
    const { win } = makeWin()
    const cb = makeCallbacks()
    attach(document, win, cb)

    document.getSelection()!.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))

    expect(cb.onSelection).toHaveBeenLastCalledWith(null)
  })

  it('clearSelection() drops the document selection', () => {
    const { win } = makeWin()
    const cb = makeCallbacks()
    const bridge = attach(document, win, cb)

    selectQuickBrown()
    bridge.clearSelection()

    expect(document.getSelection()!.rangeCount).toBe(0)
  })
})

describe('createDocBridge highlights', () => {
  it('does not crash when the CSS Custom Highlight API is absent', () => {
    const { win, flush } = makeWin()
    const cb = makeCallbacks()
    const bridge = attach(document, win, cb)

    expect(() => {
      bridge.setAnchors([{ id: 'a', anchor: anchorA }])
      bridge.setActive('a')
      flush()
    }).not.toThrow()
    expect(cb.onGeometry).toHaveBeenCalled()
  })

  it('registers hf-comment / hf-comment-active when the API exists', () => {
    const registry = new Map<string, unknown>()
    class FakeHighlight {
      ranges: Range[]
      constructor(...r: Range[]) { this.ranges = r }
    }
    const { win, flush } = makeWin({ Highlight: FakeHighlight, CSS: { highlights: registry } })
    const cb = makeCallbacks()
    const bridge = attach(document, win, cb)

    bridge.setAnchors([{ id: 'a', anchor: anchorA }])
    bridge.setActive('a')
    flush()

    expect((registry.get('hf-comment') as FakeHighlight).ranges).toHaveLength(1)
    expect((registry.get('hf-comment-active') as FakeHighlight).ranges).toHaveLength(1)

    bridge.detach()
    expect(registry.has('hf-comment')).toBe(false)
    expect(registry.has('hf-comment-active')).toBe(false)
  })

  it('injects a highlight stylesheet and removes it on detach', () => {
    const { win } = makeWin()
    const bridge = attach(document, win, makeCallbacks())

    const style = document.head.querySelector('style[data-hf-comments]')
    expect(style?.textContent).toContain('::highlight(hf-comment)')
    expect(style?.textContent).toContain('::highlight(hf-comment-active)')

    bridge.detach()
    expect(document.head.querySelector('style[data-hf-comments]')).toBeNull()
  })
})

describe('createDocBridge scrollToAnchor', () => {
  it('scrolls the anchor element into view', () => {
    const scrollIntoView = vi.fn()
    const p1 = document.getElementById('p1')!
    p1.scrollIntoView = scrollIntoView
    const { win, flush } = makeWin()
    const bridge = attach(document, win, makeCallbacks())

    bridge.setAnchors([{ id: 'a', anchor: anchorA }])
    flush()
    bridge.scrollToAnchor('a')

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
  })

  it('is a no-op for an unknown or unresolved id', () => {
    const { win } = makeWin()
    const bridge = attach(document, win, makeCallbacks())
    expect(() => bridge.scrollToAnchor('nope')).not.toThrow()
  })
})

describe('createDocBridge mutation handling', () => {
  it('rebuilds the text index after a debounced DOM mutation', async () => {
    vi.useFakeTimers()
    const { win } = makeWin({ requestAnimationFrame: undefined })
    const cb = makeCallbacks()
    const bridge = attach(document, win, cb)
    bridge.setAnchors([{ id: 'late', anchor: { ...anchorDead, quote: 'freshly added' } }])
    vi.advanceTimersByTime(20)
    expect(cb.onGeometry.mock.calls.at(-1)![0].unresolved).toEqual(['late'])

    const p = document.createElement('p')
    p.textContent = 'freshly added'
    document.body.appendChild(p)
    await Promise.resolve()
    vi.advanceTimersByTime(300)

    expect(cb.onGeometry.mock.calls.at(-1)![0].unresolved).toEqual([])
    expect(cb.onGeometry.mock.calls.at(-1)![0].positions).toEqual([{ id: 'late', y: 140 }])
  })
})

describe('createDocBridge memoization', () => {
  it('resolves each anchor once per index generation, and again after a mutation', async () => {
    vi.useFakeTimers()
    const { win } = makeWin({ requestAnimationFrame: undefined })
    const cb = makeCallbacks()
    const bridge = attach(document, win, cb)

    bridge.setAnchors([{ id: 'a', anchor: anchorA }, { id: 'dead', anchor: anchorDead }])
    vi.advanceTimersByTime(20)
    expect(hoisted.resolveCalls).toBe(2) // one per anchor

    // Scrolling cannot move a document-space y: no re-resolution, but still a report.
    document.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(20)
    document.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(20)
    expect(hoisted.resolveCalls).toBe(2)
    expect(cb.onGeometry.mock.calls.length).toBeGreaterThanOrEqual(3)

    // A DOM mutation starts a new generation — anchors must be resolved again.
    document.body.appendChild(document.createElement('p'))
    await Promise.resolve()
    vi.advanceTimersByTime(300)
    expect(hoisted.resolveCalls).toBe(4)
  })

  it('re-resolves when setAnchors supplies a new anchor for a known id', () => {
    const { win, flush } = makeWin()
    const cb = makeCallbacks()
    const bridge = attach(document, win, cb)

    bridge.setAnchors([{ id: 'a', anchor: anchorA }])
    flush()
    expect(hoisted.resolveCalls).toBe(1)

    bridge.setAnchors([{ id: 'a', anchor: { ...anchorA, quote: 'lazy dog' } }])
    flush()
    expect(hoisted.resolveCalls).toBe(2)
    expect(cb.onGeometry.mock.calls.at(-1)![0].unresolved).toEqual([])
  })
})

describe('createDocBridge detach', () => {
  it('removes every listener it added', () => {
    const addDoc = vi.spyOn(document, 'addEventListener')
    const removeDoc = vi.spyOn(document, 'removeEventListener')
    const { win, spies } = makeWin()
    const bridge = attach(document, win, makeCallbacks())

    const added = addDoc.mock.calls.map((c) => c[0])
    expect(added).toEqual(expect.arrayContaining(['scroll', 'selectionchange', 'mouseup', 'keyup']))

    bridge.detach()
    const removed = removeDoc.mock.calls.map((c) => c[0])
    for (const type of added) expect(removed).toContain(type)
    expect(spies.remove).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('stops reporting after detach and cancels a pending frame', () => {
    const { win, flush, frames, spies } = makeWin()
    const cb = makeCallbacks()
    const bridge = attach(document, win, cb)
    flush()
    cb.onGeometry.mockClear()

    bridge.setAnchors([{ id: 'a', anchor: anchorA }])
    expect(frames).toHaveLength(1)
    bridge.detach()
    expect(spies.cancelRaf).toHaveBeenCalled()
    flush()
    document.dispatchEvent(new Event('scroll'))
    flush()

    expect(cb.onGeometry).not.toHaveBeenCalled()
  })

  it('is idempotent', () => {
    const { win } = makeWin()
    const bridge = attach(document, win, makeCallbacks())
    bridge.detach()
    expect(() => bridge.detach()).not.toThrow()
  })
})

describe('attachCommentBridge', () => {
  it('returns null while the iframe document is still loading', () => {
    const iframe = {
      contentDocument: { readyState: 'loading' },
      contentWindow: {},
    } as unknown as HTMLIFrameElement
    expect(attachCommentBridge(iframe, makeCallbacks())).toBeNull()
  })

  it('returns null when there is no contentDocument', () => {
    const iframe = { contentDocument: null, contentWindow: null } as unknown as HTMLIFrameElement
    expect(attachCommentBridge(iframe, makeCallbacks())).toBeNull()
  })

  it('builds a bridge for a ready same-origin document', () => {
    const { win } = makeWin()
    const iframe = {
      contentDocument: document,
      contentWindow: win,
    } as unknown as HTMLIFrameElement
    const bridge = attachCommentBridge(iframe, makeCallbacks())
    expect(bridge).not.toBeNull()
    bridges.push(bridge!)
  })
})
