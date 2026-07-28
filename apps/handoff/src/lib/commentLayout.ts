/**
 * Card-layout engine for the comment gutter (spec §5, "Alignment engine").
 *
 * Cards want to sit level with the content they annotate, but two anchors a few
 * pixels apart would stack their cards on top of each other. `layoutCards` is
 * the pure Google-Docs-style clustering pass: sort by anchor, keep every card
 * at its anchor when it fits, otherwise push it down by `gap`. The *active*
 * card (the one the reader selected) is pinned exactly at its anchor and the
 * cards above it are pushed up instead, so clicking a highlight always lines
 * its card up with the text.
 *
 * Pure and DOM-free — measured heights are passed in — so the algebra is
 * unit-testable and the component only has to feed it numbers.
 */

export interface LayoutCardInput {
  id: string
  /** Anchor position in *document* space (not viewport). */
  anchorY: number
  /** Measured card height in px. */
  height: number
}

export const DEFAULT_CARD_GAP = 8

/**
 * Lay out gutter cards, returning `id → top` in the same document space as
 * `anchorY`. Cards never overlap and no top is ever negative.
 *
 * The active card sits exactly at its anchor in every case where there is room
 * above it for the earlier cards. In the degenerate case where there isn't (an
 * active card anchored near y=0 with cards above it), the clamp at 0 wins and
 * the final no-overlap pass nudges the active card down — the two invariants
 * genuinely conflict there, and overlapping cards are the worse failure.
 */
export function layoutCards(
  cards: LayoutCardInput[],
  activeId: string | null,
  gap: number = DEFAULT_CARD_GAP,
): Map<string, number> {
  // Stable order: by anchor, ties broken by id so re-renders don't jitter.
  const sorted = cards
    .slice()
    .sort((a, b) => a.anchorY - b.anchorY || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const tops = sorted.map((c) => c.anchorY)
  const activeIdx = activeId === null ? -1 : sorted.findIndex((c) => c.id === activeId)

  if (activeIdx >= 0) {
    // Pin the active card, then walk *up* from it: each earlier card sits at
    // its own anchor unless that would collide with the card below it.
    tops[activeIdx] = sorted[activeIdx].anchorY
    for (let i = activeIdx - 1; i >= 0; i--) {
      tops[i] = Math.min(sorted[i].anchorY, tops[i + 1] - gap - sorted[i].height)
    }
  }

  // Forward pass over everything after the active card (or the whole list when
  // nothing is active): sit at the anchor, or just below the previous card.
  for (let i = Math.max(activeIdx, 0) + 1; i < sorted.length; i++) {
    tops[i] = Math.max(sorted[i].anchorY, tops[i - 1] + sorted[i - 1].height + gap)
  }

  // Final fix-up: clamp the first card to 0 and re-resolve any overlap that the
  // clamp (or the upward pass) introduced.
  for (let i = 0; i < sorted.length; i++) {
    const min = i === 0 ? 0 : tops[i - 1] + sorted[i - 1].height + gap
    if (tops[i] < min) tops[i] = min
  }

  return new Map(sorted.map((c, i) => [c.id, tops[i]]))
}
