/**
 * The comment gutter (spec §5): a ~20rem column beside the document where each
 * thread's card sits level with the content it annotates.
 *
 * Two coordinate systems meet here. `positions` and `docHeight` are *document*
 * space — the viewer measures where each anchor lives inside the (possibly
 * iframed) content. The gutter renders one tall canvas in that same space and
 * slides it by `-scrollTop`, so a card only has to know its document Y and the
 * whole column tracks the document with one transform instead of N re-layouts.
 *
 * Threads the viewer could not place (`positions` missing their id — a deleted
 * paragraph, an anchor that no longer resolves, or no geometry at all) are not
 * dropped: they collect in the "Unanchored" section pinned to the bottom, next
 * to the "Show resolved" toggle. Resolved threads are hidden by default so a
 * settled document reads clean.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CommentAnchor, CommentThread } from '../../lib/comments'
import { layoutCards } from '../../lib/commentLayout'
import { useAddCommentMutation } from '../../store/handoffApi'
import { toast } from '../../lib/toast'
import { CommentCard } from './CommentCard'
import { CommentComposer } from './CommentComposer'

/** Layout id of the not-yet-posted draft card. Never collides with a comment id. */
const DRAFT_ID = '__draft__'

/**
 * Assumed card height until a ResizeObserver reports the real one — roughly a
 * one-line comment with its reply composer. Only ever visible for one frame.
 */
const ESTIMATED_CARD_HEIGHT = 96

export interface CommentPanelProps {
  nodeId: string
  threads: CommentThread[]
  /** Root comment id → anchor Y in document space. `null` while unmeasured. */
  positions: Map<string, number> | null
  scrollTop: number
  docHeight: number
  activeId: string | null
  onActivate: (id: string | null) => void
  canWrite: boolean
  draft: { anchorY: number; anchor: CommentAnchor } | null
  onDraftDone: () => void
}

export function CommentPanel({
  nodeId,
  threads,
  positions,
  scrollTop,
  docHeight,
  activeId,
  onActivate,
  canWrite,
  draft,
  onDraftDone,
}: CommentPanelProps) {
  const [showResolved, setShowResolved] = useState(false)
  const [heights, setHeights] = useState<Map<string, number>>(new Map())
  const toggleId = useId()

  const resolvedCount = threads.filter((t) => t.root.resolved).length
  const visible = useMemo(
    () => (showResolved ? threads : threads.filter((t) => !t.root.resolved)),
    [threads, showResolved],
  )

  const anchored = useMemo(
    () => visible.filter((t) => positions?.has(t.root.id)),
    [visible, positions],
  )
  const unanchored = useMemo(
    () => visible.filter((t) => !positions?.has(t.root.id)),
    [visible, positions],
  )

  // The draft joins the layout so a new comment cannot land under an existing
  // card, and it takes the active slot — it is by definition what the reader is
  // looking at right now.
  const tops = useMemo(() => {
    const cards = anchored.map((t) => ({
      id: t.root.id,
      anchorY: positions?.get(t.root.id) ?? 0,
      height: heights.get(t.root.id) ?? ESTIMATED_CARD_HEIGHT,
    }))
    if (draft) {
      cards.push({
        id: DRAFT_ID,
        anchorY: draft.anchorY,
        height: heights.get(DRAFT_ID) ?? ESTIMATED_CARD_HEIGHT,
      })
    }
    return layoutCards(cards, draft ? DRAFT_ID : activeId)
  }, [anchored, positions, heights, draft, activeId])

  // --- Height measurement -------------------------------------------------
  // Cards grow when a thread gains a reply or an editor opens, so heights are
  // observed rather than computed. jsdom has no ResizeObserver; there the
  // estimate stands, which is exactly what the layout tests pin.
  const cardEls = useRef(new Map<string, HTMLElement>())
  const setCardEl = useCallback((id: string) => {
    return (el: HTMLElement | null) => {
      if (el) cardEls.current.set(id, el)
      else cardEls.current.delete(id)
    }
  }, [])

  const cardIds = anchored.map((t) => t.root.id).join('|') + (draft ? `|${DRAFT_ID}` : '')
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const measure = (el: HTMLElement, id: string) => {
      setHeights((prev) => {
        const next = el.offsetHeight
        if (!next || prev.get(id) === next) return prev
        const copy = new Map(prev)
        copy.set(id, next)
        return copy
      })
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        const id = el.dataset.cardId
        if (id) measure(el, id)
      }
    })
    for (const [id, el] of cardEls.current) {
      observer.observe(el)
      measure(el, id)
    }
    return () => observer.disconnect()
    // `cardIds` is the identity of the observed set — re-observe when it changes.
  }, [cardIds])

  const [addComment, { isLoading: posting }] = useAddCommentMutation()
  async function postDraft(body: string) {
    if (!draft) return
    try {
      await addComment({ nodeId, body, anchor: draft.anchor }).unwrap()
      onDraftDone()
    } catch (err) {
      toast('Couldn’t post the comment. Please try again.', 'error')
      // Rethrow so the draft composer keeps the typed text for a retry.
      throw err
    }
  }

  return (
    <aside
      aria-label="Comments"
      className="relative flex w-80 shrink-0 flex-col overflow-hidden border-l border-border bg-surface-2"
    >
      {/* Document-space canvas: cards carry document Ys, the canvas does the scroll. */}
      <div className="relative flex-1 overflow-hidden">
        <div
          data-testid="comment-gutter-canvas"
          className="absolute inset-x-0 top-0"
          style={{ height: docHeight, transform: `translateY(${-scrollTop}px)` }}
        >
          {anchored.map((t) => (
            <div
              key={t.root.id}
              ref={setCardEl(t.root.id)}
              data-card-id={t.root.id}
              data-testid={`gutter-card-${t.root.id}`}
              className="absolute left-3 right-3 transition-[top] duration-150"
              style={{ top: tops.get(t.root.id) ?? 0 }}
            >
              <CommentCard
                thread={t}
                nodeId={nodeId}
                active={activeId === t.root.id}
                canWrite={canWrite}
                onActivate={() => onActivate(t.root.id)}
              />
            </div>
          ))}

          {draft && (
            <div
              ref={setCardEl(DRAFT_ID)}
              data-card-id={DRAFT_ID}
              data-testid={`gutter-card-${DRAFT_ID}`}
              className="absolute left-3 right-3 transition-[top] duration-150"
              style={{ top: tops.get(DRAFT_ID) ?? 0 }}
            >
              <div className="rounded-xl border border-accent-600 bg-surface p-3 shadow-sm ring-1 ring-accent-600">
                {canWrite ? (
                  <CommentComposer
                    onSubmit={postDraft}
                    busy={posting}
                    placeholder="Add a comment…"
                    onCancel={onDraftDone}
                    autoFocus
                  />
                ) : (
                  <p className="text-sm text-muted">Sign in to comment</p>
                )}
              </div>
            </div>
          )}

          {!anchored.length && !draft && !unanchored.length && (
            <p className="px-3 pt-4 text-sm text-muted">
              {canWrite ? 'Select text or click the image to comment.' : 'No comments yet.'}
            </p>
          )}
        </div>
      </div>

      {/* Bottom rail: everything that has no place in the document. */}
      {(unanchored.length > 0 || resolvedCount > 0 || !canWrite) && (
        <div className="max-h-[50%] shrink-0 overflow-y-auto border-t border-border bg-surface-2 px-3 py-2">
          {unanchored.length > 0 && (
            <section data-testid="unanchored-section">
              <h2 className="pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                Unanchored
              </h2>
              <ul className="space-y-2">
                {unanchored.map((t) => (
                  <li key={t.root.id}>
                    <CommentCard
                      thread={t}
                      nodeId={nodeId}
                      active={activeId === t.root.id}
                      canWrite={canWrite}
                      onActivate={() => onActivate(t.root.id)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {resolvedCount > 0 && (
            <label
              htmlFor={toggleId}
              className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted"
            >
              <input
                id={toggleId}
                type="checkbox"
                checked={showResolved}
                onChange={(e) => setShowResolved(e.target.checked)}
                className="accent-accent-600"
              />
              Show resolved ({resolvedCount})
            </label>
          )}

          {!canWrite && <p className="mt-2 text-xs text-muted">Sign in to comment</p>}
        </div>
      )}
    </aside>
  )
}
