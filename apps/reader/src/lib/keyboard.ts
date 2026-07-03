/**
 * Keyboard navigation — the pure, tested seam for story #118. The reading
 * surface listens for keydown and turns it into two decisions, both here:
 *
 * 1. {@link keyToAction} maps a raw key to an intent (move / page / star /
 *    toggle-read / open), or `null` for keys we don't handle.
 * 2. {@link nextSelection} computes the guid the cursor lands on after a j/k
 *    move over the ordered visible list.
 *
 * Keeping both as pure functions means the component only wires DOM events to
 * intents and dispatches to the existing star/read/open handlers — no
 * navigation logic lives in React, so the transitions are unit-testable.
 */

/** Which way a j/k move steps through the list. */
export type NavDirection = 'next' | 'prev'

/** The intent a handled key expresses, acted on against the current cursor. */
export type KeyAction =
  | { kind: 'move'; dir: NavDirection } // j / k — step the cursor
  | { kind: 'page' } // space — page down the list
  | { kind: 'star' } // s — toggle star on the cursor item
  | { kind: 'toggleRead' } // m — toggle read on the cursor item
  | { kind: 'open' } // o / enter — open the cursor item (marks it read)

/**
 * Map a `KeyboardEvent.key` to its {@link KeyAction}, or `null` when the key
 * isn't a reader shortcut. Letters match lowercase only — an uppercase `J`
 * (shift held) is intentionally ignored so shifted chords don't navigate.
 */
export function keyToAction(key: string): KeyAction | null {
  switch (key) {
    case 'j':
      return { kind: 'move', dir: 'next' }
    case 'k':
      return { kind: 'move', dir: 'prev' }
    case ' ':
      return { kind: 'page' }
    case 's':
      return { kind: 'star' }
    case 'm':
      return { kind: 'toggleRead' }
    case 'o':
    case 'Enter':
      return { kind: 'open' }
    default:
      return null
  }
}

/**
 * The guid the cursor should land on after a j/k move over `guids` (the ordered
 * visible list). From no selection, `next` lands on the first item and `prev` on
 * the last. At an edge the cursor stays put — no wrap-around, so holding j at the
 * bottom doesn't loop back to the top. A `current` guid absent from the list is
 * treated as no selection. Empty list → `null`.
 */
export function nextSelection(
  guids: string[],
  current: string | null,
  dir: NavDirection,
): string | null {
  if (guids.length === 0) return null
  const idx = current === null ? -1 : guids.indexOf(current)
  if (idx === -1) return dir === 'next' ? guids[0] : guids[guids.length - 1]
  const target = dir === 'next' ? idx + 1 : idx - 1
  if (target < 0 || target >= guids.length) return current // clamp at the edges
  return guids[target]
}
