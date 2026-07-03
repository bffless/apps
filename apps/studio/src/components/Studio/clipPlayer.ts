/**
 * One thing audible at a time. The cut editor's original-audio player (and any
 * other `<audio>` element) claims playback here; claiming pauses whatever was
 * playing before.
 */
let current: HTMLAudioElement | null = null

/** An `<audio>` element is taking over: pause whatever else was playing and
 *  track the element so the next claim pauses it in turn. */
export function claimPlayback(el: HTMLAudioElement) {
  if (current && current !== el) current.pause()
  current = el
}
