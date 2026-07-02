import { useState } from 'react'
import { clockLabel } from '../../lib/contactSheet'

/** One thumbnail in the sibling filmstrip: a nearby global-timeline second and
 *  its captured preview data URL. */
type Sibling = { time: number; thumb: string }

type Props = {
  /** The image's current bucket serve URL (the one baked into the post). */
  src: string
  /** The caption / alt text (shown in italics beneath, like the read-only figure). */
  alt: string
  /** The global-timeline second this image was captured at — the strip centres here. */
  time: number
  /** Capture the filmstrip of nearby frames (in-browser thumbnails, nothing uploads). */
  capture: (time: number) => Promise<Sibling[]>
  /** Re-capture at a picked second, upload, and swap it into the post. Resolves
   *  true on success (the post's `src`/`time` then update from the store). */
  reframe: (oldUrl: string, time: number) => Promise<boolean>
}

/**
 * A blog-post figure with a "Change frame" affordance (issue #91). The AI picks a
 * frame by timestamp and we render it faithfully — but it sometimes lands on a bad
 * instant (mid-blink, a weird face). Clicking Change frame captures a filmstrip of
 * nearby frames (±5s at 1s); picking one recaptures a clean full-res frame at that
 * second, uploads it, and swaps it into the post. Read-only until opened, so the
 * preview stays calm; the current frame is flagged in the strip.
 */
export function BlogFigure({ src, alt, time, capture, reframe }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [siblings, setSiblings] = useState<Sibling[]>([])
  const [busyTime, setBusyTime] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function openStrip() {
    setOpen(true)
    setError(null)
    setLoading(true)
    try {
      const got = await capture(time)
      setSiblings(got)
      if (got.length === 0) setError('Couldn’t load nearby frames — try again.')
    } catch {
      setError('Couldn’t load nearby frames — try again.')
    } finally {
      setLoading(false)
    }
  }

  function close() {
    setOpen(false)
    setSiblings([])
    setBusyTime(null)
    setError(null)
  }

  async function pick(t: number) {
    if (busyTime !== null || t === time) return
    setBusyTime(t)
    setError(null)
    try {
      const ok = await reframe(src, t)
      if (ok) close() // the store swaps src/time; the figure re-renders on the new frame
      else setError('Couldn’t update the frame — try again.')
    } catch {
      setError('Couldn’t update the frame — try again.')
    } finally {
      setBusyTime((cur) => (cur === t ? null : cur))
    }
  }

  return (
    <figure className="flex flex-col gap-1">
      <div className="group relative">
        <img src={src} alt={alt} className="w-full rounded-md border border-paper-line" />
        {!open && (
          <button
            type="button"
            onClick={openStrip}
            className="pill-ghost absolute right-2 top-2 bg-paper/90 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            Change frame
          </button>
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-2 rounded-md border border-paper-line bg-paper-deep/10 p-2">
          <div className="flex items-center justify-between">
            <span className="meta-label">Pick a nearby frame</span>
            <button type="button" className="pill-ghost" onClick={close} disabled={busyTime !== null}>
              Close
            </button>
          </div>

          {loading ? (
            <p className="px-1 py-3 text-[12px] text-ink-soft">Loading nearby frames…</p>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {siblings.map((s) => {
                const current = s.time === time
                const busy = busyTime === s.time
                return (
                  <button
                    key={s.time}
                    type="button"
                    onClick={() => pick(s.time)}
                    disabled={current || busyTime !== null}
                    aria-current={current || undefined}
                    title={current ? 'Current frame' : `Use frame at ${clockLabel(s.time)}`}
                    className={`relative shrink-0 overflow-hidden rounded border transition ${
                      current
                        ? 'border-ink ring-2 ring-ink'
                        : 'border-paper-line hover:border-ink/60 disabled:opacity-60'
                    }`}
                  >
                    <img src={s.thumb} alt="" className="block h-[72px] w-auto" />
                    <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center font-mono text-[10px] text-white">
                      {current ? 'current' : busy ? '…' : clockLabel(s.time)}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {error && <p className="px-1 text-[12px] text-rose-600">{error}</p>}
        </div>
      )}

      {alt && <figcaption className="text-[12.5px] text-ink-soft italic">{alt}</figcaption>}
    </figure>
  )
}
