import { useRef, useState } from 'react'
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
  /** Capture the filmstrip of nearby frames (small in-browser thumbnails, no upload). */
  capture: (time: number) => Promise<Sibling[]>
  /** Capture a large preview frame at a scrubbed second (no upload) — what the
   *  producer sees at figure size before committing. Empty string on failure. */
  preview: (time: number) => Promise<string>
  /** Re-capture at the chosen second, upload, and swap it into the post. Resolves
   *  true on success (the post's `src`/`time` then update from the store). */
  reframe: (oldUrl: string, time: number) => Promise<boolean>
}

/**
 * A blog-post figure with a "Change frame" affordance (issue #91). The AI picks a
 * frame by timestamp and we render it faithfully — but it sometimes lands on a bad
 * instant (mid-blink, a weird face). Clicking Change frame opens a filmstrip of
 * nearby frames (±30s); clicking a thumbnail PREVIEWS it large in place of the
 * image (nothing committed yet), so the producer can scrub through options — the
 * strip thumbnails are too small to judge a face by. "Use this frame" then
 * recaptures a clean full-res frame at that second, uploads it, and swaps it into
 * the post. Read-only until opened, so the preview stays calm.
 */
export function BlogFigure({ src, alt, time, capture, preview, reframe }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [siblings, setSiblings] = useState<Sibling[]>([])
  const [selected, setSelected] = useState(time)
  const [previews, setPreviews] = useState<Map<number, string>>(new Map())
  const [previewLoading, setPreviewLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The most recently requested preview second, so a slow capture that resolves
  // after the producer has already clicked elsewhere doesn't clobber the view.
  const wantRef = useRef(time)

  async function openStrip() {
    setOpen(true)
    setSelected(time)
    setPreviews(new Map())
    setError(null)
    setLoading(true)
    wantRef.current = time
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
    setSelected(time)
    setPreviews(new Map())
    setPreviewLoading(false)
    setSaving(false)
    setError(null)
  }

  // Preview a sibling: select it and (for anything but the current frame, which we
  // already have full-size in `src`) lazily capture + cache its large preview.
  async function selectSibling(t: number) {
    if (saving) return
    setSelected(t)
    setError(null)
    wantRef.current = t
    if (t === time || previews.has(t)) {
      setPreviewLoading(false)
      return
    }
    setPreviewLoading(true)
    try {
      const dataUrl = await preview(t)
      if (dataUrl) {
        setPreviews((m) => new Map(m).set(t, dataUrl))
      } else if (wantRef.current === t) {
        setError('Couldn’t load that frame — try another.')
      }
    } catch {
      if (wantRef.current === t) setError('Couldn’t load that frame — try another.')
    } finally {
      if (wantRef.current === t) setPreviewLoading(false)
    }
  }

  // Commit the selected frame: recapture full-res, upload, swap into the post.
  async function save() {
    if (selected === time || saving) return
    setSaving(true)
    setError(null)
    try {
      const ok = await reframe(src, selected)
      if (ok) close() // the store swaps src/time; the figure re-renders on the new frame
      else setError('Couldn’t update the frame — try again.')
    } catch {
      setError('Couldn’t update the frame — try again.')
    } finally {
      setSaving(false)
    }
  }

  const atOriginal = selected === time
  const previewSrc = atOriginal ? src : previews.get(selected) ?? src

  return (
    <figure className="flex flex-col gap-1">
      <div className="group relative">
        <img
          src={open ? previewSrc : src}
          alt={alt}
          className={`w-full rounded-md border border-line transition-opacity ${
            previewLoading ? 'opacity-50' : ''
          }`}
        />
        {open && previewLoading && (
          <span className="absolute inset-0 flex items-center justify-center text-[12px] text-ink-soft">
            Loading preview…
          </span>
        )}
        {open && !atOriginal && !previewLoading && (
          <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">
            preview · {clockLabel(selected)}
          </span>
        )}
        {!open && (
          <button
            type="button"
            onClick={openStrip}
            className="pill-ghost absolute right-2 top-2 bg-surface/90 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            Change frame
          </button>
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-dim/10 p-2">
          <div className="flex items-center justify-between">
            <span className="meta-label">Click a frame to preview it above</span>
            <button type="button" className="pill-ghost" onClick={close} disabled={saving}>
              Cancel
            </button>
          </div>

          {loading ? (
            <p className="px-1 py-3 text-[12px] text-ink-soft">Loading nearby frames…</p>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {siblings.map((s) => {
                const isSelected = s.time === selected
                const isOriginal = s.time === time
                return (
                  <button
                    key={s.time}
                    type="button"
                    onClick={() => selectSibling(s.time)}
                    disabled={saving}
                    aria-current={isSelected || undefined}
                    title={`Preview frame at ${clockLabel(s.time)}${isOriginal ? ' (original)' : ''}`}
                    className={`relative shrink-0 overflow-hidden rounded border transition ${
                      isSelected
                        ? 'border-ink ring-2 ring-ink'
                        : 'border-line hover:border-ink/60'
                    }`}
                  >
                    <img src={s.thumb} alt="" className="block h-16 w-auto" />
                    <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center font-mono text-[9px] text-white">
                      {isOriginal ? 'original' : clockLabel(s.time)}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {error && <p className="px-1 text-[12px] text-rose-600">{error}</p>}

          {!loading && siblings.length > 0 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-ink-soft">
                {atOriginal ? 'Showing the original frame' : `Previewing ${clockLabel(selected)}`}
              </span>
              <button
                type="button"
                className="pill-ghost"
                onClick={save}
                disabled={atOriginal || previewLoading || saving}
              >
                {saving ? 'Saving…' : 'Use this frame'}
              </button>
            </div>
          )}
        </div>
      )}

      {alt && <figcaption className="text-[12.5px] text-ink-soft italic">{alt}</figcaption>}
    </figure>
  )
}
