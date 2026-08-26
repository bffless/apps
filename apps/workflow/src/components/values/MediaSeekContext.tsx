/**
 * A `transcript` viewer's click and the nearest video/audio player's
 * `currentTime`, wired without either knowing the other exists (02/08): a
 * segment button calls `seek(start)`, and the first player registered under
 * the same `MediaSeekProvider` jumps there. "First registered" rather than
 * "nearest in the DOM" is deliberate — a provider is scoped to one step's
 * pane or one run/job's output block (`StepPane`'s Output tab, each
 * `RunOutputs` scope), so there is normally at most one player in scope
 * anyway; the ordering only matters when there happen to be several, and
 * registration order is the simplest rule that needs no DOM measurement.
 *
 * `.tsx` rather than the plan's `.ts`: the provider renders a
 * `Context.Provider` element, so the file needs JSX.
 *
 * `useMediaSeek` is safe to call with no provider in the tree — every
 * existing `FileCard` render (outside a transcript's scope, e.g. an `Input`
 * tab or a bare `ValueView` in a test) still needs `register` to be callable
 * — so the no-provider case returns a no-op implementation instead of
 * throwing.
 */
import { createContext, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface MediaSeek {
  register(el: HTMLMediaElement): () => void
  seek(seconds: number): boolean
}

const NOOP: MediaSeek = {
  register: () => () => {},
  seek: () => false,
}

const Context = createContext<MediaSeek | null>(null)

export function MediaSeekProvider({ children }: { children: ReactNode }) {
  const elements = useRef<HTMLMediaElement[]>([])
  // The stable-forever slot for the api object (`IslandView`'s own comment on
  // its host explains why: a `useState` lazy initialiser, never a `useRef`
  // read during render, and never recomputed on re-render).
  const [api] = useState<MediaSeek>(() => ({
    register(el) {
      elements.current.push(el)
      return () => {
        elements.current = elements.current.filter((candidate) => candidate !== el)
      }
    },
    seek(seconds) {
      const first = elements.current[0]
      if (!first) return false
      first.currentTime = seconds
      return true
    },
  }))

  return <Context.Provider value={api}>{children}</Context.Provider>
}

// A context module's hook belongs beside its Provider, not split into a
// same-purpose second file just to satisfy fast refresh.
// eslint-disable-next-line react-refresh/only-export-components
export function useMediaSeek(): MediaSeek {
  return useContext(Context) ?? NOOP
}
