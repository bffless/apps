/**
 * Which implementation the values on screen came from.
 *
 * Almost every viewer needs nothing but the value; `render: island` needs one
 * more fact — the bundle its island file lives in — and that fact is known at
 * the *page* level (`RunPage` reads it off the run), not at the value. Passing
 * it through every intermediate component that renders a `ValueView` would put
 * an `impl` prop on components that have no other use for one, so it rides a
 * context instead. `null` is a legitimate answer (a value rendered outside any
 * run); `IslandView` is not reachable without an implementation, so a named
 * `render: island` degrades to the ordinary badge there.
 */
import { createContext, useContext } from 'react'

export const ImplContext = createContext<string | null>(null)

export function useImpl(): string | null {
  return useContext(ImplContext)
}

/**
 * Why the context above holds `null`: absent because there is no run on
 * screen, or **withheld** because the run row named an implementation the
 * page refused to trust (apps#364 — not a discovered alias, a preview alias,
 * or discovery has not answered yet). The two nulls draw differently: absent
 * gets the ordinary "renderer: island (no implementation)" badge, withheld
 * gets a one-line note saying the island was withheld on purpose. Only
 * `RunPage` sets this; everywhere else the default `false` keeps the old
 * badge.
 */
export const ImplWithheldContext = createContext<boolean>(false)

export function useImplWithheld(): boolean {
  return useContext(ImplWithheldContext)
}
