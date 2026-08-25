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
