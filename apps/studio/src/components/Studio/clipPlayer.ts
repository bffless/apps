import { useSyncExternalStore } from 'react'

/**
 * Singleton clip player for the per-run voice previews: one clip plays at a
 * time, clicking the playing clip's button pauses it (not restarts), and any
 * button can subscribe to whether *its* url is the one playing.
 */
let current: HTMLAudioElement | null = null
let currentUrl: string | null = null

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Play `url` from the start, pausing whatever else was playing — unless `url`
 *  is already playing, in which case pause it (the play button is a toggle). */
export function toggleClip(url: string) {
  if (current && currentUrl === url && !current.paused && !current.ended) {
    current.pause()
    return
  }
  if (current) current.pause()
  const audio = new Audio(url)
  current = audio
  currentUrl = url
  audio.addEventListener('play', emit)
  audio.addEventListener('pause', emit)
  audio.addEventListener('ended', emit)
  void audio.play().catch(() => {})
  emit()
}

/** An external `<audio>` element (the original-audio player) is taking over:
 *  pause whatever clip is playing and track the element so the next clip play
 *  pauses it in turn. One thing audible at a time. */
export function claimPlayback(el: HTMLAudioElement) {
  if (current && current !== el) current.pause()
  current = el
  currentUrl = null
  emit()
}

/** Whether `url` is the clip currently playing. */
export function useClipPlaying(url: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !!url && currentUrl === url && !!current && !current.paused && !current.ended,
  )
}
