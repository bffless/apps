import { useEffect, useMemo, useRef, useState } from 'react'
import type { Scene } from '../../lib/scenes'
import {
  videoScript,
  videoChapters,
  formatChapters,
  scriptWords,
  type VideoDescription,
} from '../../lib/describe'
import { TranscriptText } from './TranscriptText'

type Props = {
  scenes: Scene[]
  /** The director's one-line take (synopsis) — shown as context, not the title. */
  synopsis: string | null
  /** The generated title + summary (+ the script it was written from), or null. */
  description: (VideoDescription & { script: string }) | null
  generating: boolean
  onGenerate: () => void
  onTitleChange: (title: string) => void
}

/**
 * The Export step's "finished product" header (story: export info). Shows the
 * video's recommended title (editable), the director's take, a YouTube-ready
 * description (AI summary of the FINAL cut + chapter timestamps) in a copy-paste
 * textarea, and the full spoken script in the prep transcript treatment. The
 * summary is generated once on arrival from `/api/describe` and cached — only
 * re-run when the final script changes.
 */
export function ExportSummary({
  scenes,
  synopsis,
  description,
  generating,
  onGenerate,
  onTitleChange,
}: Props) {
  const script = useMemo(() => videoScript(scenes), [scenes])
  const chapters = useMemo(() => videoChapters(scenes), [scenes])
  const words = useMemo(() => scriptWords(scenes), [scenes])

  // YouTube-ready description: the summary, then the chapter lines ("0:00 Title")
  // that YouTube turns into chapters. Chapters show even before the AI summary.
  const ytDescription = useMemo(
    () => [description?.summary, formatChapters(chapters)].filter(Boolean).join('\n\n'),
    [description?.summary, chapters],
  )

  const [scriptOpen, setScriptOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const descRef = useRef<HTMLTextAreaElement>(null)

  // Auto-generate once when we land here (or after the script changes), but never
  // loop on failure — `attemptedRef` records the script we've already kicked off
  // for, so only an explicit Regenerate re-runs it.
  const attemptedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!script || generating) return
    const stale = !description || description.script !== script
    if (stale && attemptedRef.current !== script) {
      attemptedRef.current = script
      onGenerate()
    }
  }, [script, description, generating, onGenerate])

  async function copyDescription() {
    const text = descRef.current?.value ?? ytDescription
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable (insecure context) — the textarea is still selectable.
    }
  }

  return (
    <div className="flex flex-col gap-5 border rule bg-paper p-5">
      {/* Recommended title — editable */}
      <div>
        <label htmlFor="export-title" className="meta-label">
          Title
        </label>
        <input
          id="export-title"
          value={description?.title ?? ''}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder={generating ? 'Generating a title…' : 'Your video title'}
          className="mt-1 w-full bg-transparent font-serif text-[22px] leading-tight text-ink outline-none placeholder:text-ink-faint"
        />
      </div>

      {/* The director's take (synopsis) — context, not the title */}
      {synopsis && (
        <div>
          <p className="meta-label">The director’s take</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">{synopsis}</p>
        </div>
      )}

      {/* YouTube-ready description: summary + chapter timestamps, copy-pasteable */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="meta-label">Description &amp; chapters — copy for YouTube</p>
          <div className="flex items-center gap-2">
            <button type="button" className="pill-ghost" disabled={generating} onClick={onGenerate}>
              {generating ? 'Generating…' : 'Regenerate'}
            </button>
            <button type="button" className="pill-ghost" onClick={copyDescription}>
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
        </div>
        {/* `key` resets the (editable) textarea when the generated text changes. */}
        <textarea
          key={ytDescription}
          ref={descRef}
          defaultValue={ytDescription}
          rows={Math.min(16, Math.max(5, 3 + chapters.length))}
          placeholder={
            generating ? 'Writing a summary of the final cut…' : 'No description yet.'
          }
          className="mt-2 w-full resize-y rounded-md border border-paper-line bg-paper-deep/20 p-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none"
        />
      </div>

      {/* Full spoken script — collapsible, shown in the prep transcript treatment */}
      <div>
        <button
          type="button"
          className="meta-label flex items-center gap-1.5"
          aria-expanded={scriptOpen}
          onClick={() => setScriptOpen((v) => !v)}
        >
          <span aria-hidden="true">{scriptOpen ? '▾' : '▸'}</span> Full script
        </button>
        {scriptOpen && (
          <div className="mt-2">
            <TranscriptText words={words} label="Script" />
          </div>
        )}
      </div>
    </div>
  )
}
