import { useEffect, useState } from 'react'
import { thumbnailFileName } from '../../lib/thumbnail'

type Props = {
  /** The recommended title (from the Export description). */
  title: string
  /** The YouTube-ready description block (summary + chapters). */
  description: string
  /** Persisted thumbnail (notes + prompt + serve path), or null. */
  thumbnail: { notes: string; prompt: string; url: string } | null
  drafting: boolean
  rendering: boolean
  /** Draft a prompt; resolves to the drafted text (or null on failure). */
  onDraft: (title: string, description: string, notes: string) => Promise<string | null>
  /** Render the image from the (edited) prompt + notes. */
  onRender: (notes: string, prompt: string) => void
  /** Sign a serve path into a displayable direct URL. */
  signFor: (url: string) => Promise<string>
}

/**
 * Export-step YouTube thumbnail generator (story 06). The creator writes free-text
 * notes → Draft prompt (an AI handler that loads the `image-prompts` skill) →
 * edit the prompt → Generate → google/nano-banana renders the image, saved to the
 * bucket + project. The saved serve path is re-signed for display + download.
 */
export function ThumbnailStudio({
  title,
  description,
  thumbnail,
  drafting,
  rendering,
  onDraft,
  onRender,
  signFor,
}: Props) {
  const [notes, setNotes] = useState(thumbnail?.notes ?? '')
  const [prompt, setPrompt] = useState(thumbnail?.prompt ?? '')
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  // Re-sign the persisted thumbnail for <img>/download whenever its serve path
  // changes (new render or a restored session). Serve paths can't be shown
  // directly — big media must go through a signed direct-bucket URL.
  useEffect(() => {
    let cancelled = false
    const url = thumbnail?.url
    if (!url) {
      // No serve path — clear async so we never setState synchronously in the
      // effect body (react-hooks/set-state-in-effect).
      Promise.resolve().then(() => { if (!cancelled) setSignedUrl(null) })
      return () => { cancelled = true }
    }
    signFor(url)
      .then((u) => { if (!cancelled) setSignedUrl(u) })
      .catch(() => { if (!cancelled) setSignedUrl(null) })
    return () => { cancelled = true }
  }, [thumbnail?.url, signFor])

  async function handleDraft() {
    const drafted = await onDraft(title, description, notes)
    if (drafted != null) setPrompt(drafted)
  }

  // Force an actual file download. The signed URL is a cross-origin GCS link, so
  // an <a download> is ignored by the browser (it just navigates). Fetch the
  // bytes and save them via an object URL instead; if the cross-origin fetch is
  // blocked (CORS) or fails, fall back to opening the image in a new tab.
  async function handleDownload() {
    if (!signedUrl) return
    setDownloading(true)
    try {
      const res = await fetch(signedUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = thumbnailFileName(title)
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
    } catch {
      window.open(signedUrl, '_blank', 'noopener,noreferrer')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 border rule bg-paper p-5">
      <div>
        <p className="meta-label">YouTube thumbnail</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
          Describe what you want, draft a prompt, tweak it, then generate the image.
        </p>
      </div>

      {/* Creator notes */}
      <div>
        <label htmlFor="thumb-notes" className="meta-label">
          What should the thumbnail be like?
        </label>
        <textarea
          id="thumb-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="e.g. bold, dark navy, show the terminal — excited energy"
          className="mt-1 w-full resize-y rounded-md border border-paper-line bg-paper-deep/20 p-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
        />
        <button type="button" className="pill-ghost mt-2" disabled={drafting} onClick={handleDraft}>
          {drafting ? 'Drafting…' : 'Draft prompt'}
        </button>
      </div>

      {/* Editable drafted prompt */}
      <div>
        <label htmlFor="thumb-prompt" className="meta-label">
          Image prompt — edit before generating
        </label>
        <textarea
          id="thumb-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={8}
          placeholder={drafting ? 'Drafting a prompt…' : 'Draft a prompt, or paste your own.'}
          className="mt-1 w-full resize-y rounded-md border border-paper-line bg-paper-deep/20 p-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="button"
          className="pill-cta mt-2"
          disabled={rendering || !prompt.trim()}
          onClick={() => onRender(notes, prompt)}
        >
          {rendering ? 'Generating…' : thumbnail ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {/* Result */}
      {signedUrl && (
        <div className="flex flex-col gap-2">
          <img
            src={signedUrl}
            alt="Generated YouTube thumbnail"
            className="w-full max-w-2xl rounded-md border border-paper-line"
          />
          <button
            type="button"
            className="pill-ghost w-fit"
            disabled={downloading}
            onClick={handleDownload}
          >
            {downloading ? 'Downloading…' : 'Download'}
          </button>
        </div>
      )}
    </div>
  )
}
