import type { ContactSheet } from '../../lib/frames'
import { clockLabel } from '../../lib/contactSheet'

const fmtBytes = (b: number) =>
  b >= 1_000_000 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`

type Props = {
  sheets: ContactSheet[]
  /** Heading — defaults to the prep "Director contact sheets". The scene refiner
   *  reuses this with its own label. */
  title?: string
  /** Footer blurb explaining what the sheets are for. */
  caption?: string
}

/**
 * Contact sheets shown as images, so the producer can actually see the frames the
 * AI is handed. Used both for the prep director sheets (under the video) and the
 * per-scene refiner sheets (story 03c). Gemini takes up to 10 images, so a span
 * is tiled across several sheets — we show **every** one, since this is exactly
 * what the model receives; the list scrolls so it never takes over the page.
 * Renders from the bucket `url` once uploaded, falling back to the local blob.
 */
export function ContactSheetPreview({
  sheets,
  title = 'Director contact sheets',
  caption = 'Visual context for the AI director — handed alongside the transcript so it can decide what footage to cut, not just rewrite the words.',
}: Props) {
  if (sheets.length === 0) return null

  const frames = sheets.reduce((n, s) => n + s.count, 0)
  const interval = Math.round(sheets[0]?.interval ?? 0)

  return (
    <div className="border rule bg-paper-deep/30 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="meta-label">{title}</p>
        <p className="font-mono text-[12px] text-ink-mute">
          {sheets.length} {sheets.length === 1 ? 'image' : 'images'} · {frames} frames · ~{interval}s
          apart
        </p>
      </div>

      {/* Every sheet, bounded + scrollable — this is what the model is sent. */}
      <div className="flex max-h-[28rem] flex-col gap-4 overflow-y-auto pr-1">
        {sheets.map((sheet) => {
          const first = sheet.times[0] ?? 0
          const last = sheet.times[sheet.times.length - 1] ?? first
          return (
            <figure key={sheet.index} className="flex flex-col gap-1">
              <figcaption className="flex items-baseline justify-between font-mono text-[11px] text-ink-mute">
                <span>
                  Sheet {sheet.index + 1}/{sheet.total} · {clockLabel(first)}–{clockLabel(last)}
                </span>
                <span>
                  {sheet.count} frames · {fmtBytes(sheet.bytes)}
                </span>
              </figcaption>
              {/* Prefer the bucket URL once uploaded (loads through the serve
                  route — same bytes the director gets); fall back to the local
                  blob only during the brief capture→upload window. */}
              <img
                src={sheet.url ?? sheet.dataUrl}
                alt={`Frames ${clockLabel(first)} to ${clockLabel(last)} with burned-in timestamps`}
                className="w-full rounded border border-paper-line"
                draggable={false}
              />
            </figure>
          )
        })}
      </div>

      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">{caption}</p>
    </div>
  )
}
