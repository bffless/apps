import { useEffect, useState } from 'react'
import { referenceFileError, thumbnailFileName } from '../../lib/thumbnail'

type Props = {
  /** The recommended title (from the Export description). */
  title: string
  /** The YouTube-ready description block (summary + chapters). */
  description: string
  /** Persisted thumbnail (notes + prompt + serve path + reference), or null. */
  thumbnail: {
    notes: string
    prompt: string
    url: string
    /** Optional reference image serve path fed to nano-banana. */
    referenceUrl?: string
  } | null
  drafting: boolean
  rendering: boolean
  /**
   * Draft a prompt; resolves to the drafted text (or null on failure).
   * `hasReference` tells the drafting handler a reference photo is attached, so
   * the prompt is written to build the thumbnail around it — without it the
   * prompt bans photorealistic humans and nano-banana drops the photo.
   */
  onDraft: (
    title: string,
    description: string,
    notes: string,
    hasReference: boolean,
  ) => Promise<string | null>
  /** Render the image from the (edited) prompt + notes + optional reference. */
  onRender: (notes: string, prompt: string, referenceUrl: string | null) => void
  /** Upload a reference image to the bucket; resolves to its serve path. */
  onUploadReference: (file: File) => Promise<string>
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
  onUploadReference,
  signFor,
}: Props) {
  const [notes, setNotes] = useState(thumbnail?.notes ?? '')
  const [prompt, setPrompt] = useState(thumbnail?.prompt ?? '')
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  // The optional reference image: a serve path (persisted with the thumbnail so
  // it survives reload) plus its signed preview URL.
  const [referenceUrl, setReferenceUrl] = useState<string | null>(
    thumbnail?.referenceUrl ?? null,
  )
  const [referencePreview, setReferencePreview] = useState<string | null>(null)
  // Whether the prompt in the box was drafted while a reference was attached.
  // `null` = nothing drafted in THIS session, which covers a restored one (its
  // prompt and reference were saved together) — so the stale hint only fires on
  // the real mistake: draft here, then attach.
  const [draftedWithReference, setDraftedWithReference] = useState<boolean | null>(null)
  const [uploadingReference, setUploadingReference] = useState(false)
  const [referenceError, setReferenceError] = useState<string | null>(null)

  // Same signed-URL dance as the rendered thumbnail below — a serve path can't
  // go straight into an image tag.
  useEffect(() => {
    let cancelled = false
    if (!referenceUrl) {
      Promise.resolve().then(() => { if (!cancelled) setReferencePreview(null) })
      return () => { cancelled = true }
    }
    signFor(referenceUrl)
      .then((u) => { if (!cancelled) setReferencePreview(u) })
      .catch(() => { if (!cancelled) setReferencePreview(null) })
    return () => { cancelled = true }
  }, [referenceUrl, signFor])

  // Upload straight to the bucket via the presigned `thumbnails` flow, then keep
  // only the returned serve path. A failure is surfaced rather than swallowed —
  // generating without the creator's face silently is the wrong outcome.
  async function handleReferencePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    const invalid = referenceFileError(file)
    if (invalid) {
      setReferenceError(invalid)
      return
    }

    setReferenceError(null)
    setUploadingReference(true)
    try {
      setReferenceUrl(await onUploadReference(file))
    } catch (err) {
      setReferenceError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploadingReference(false)
    }
  }

  // Re-sign the persisted thumbnail for display/download whenever its serve path
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
    const hasReference = referenceUrl != null
    const drafted = await onDraft(title, description, notes, hasReference)
    if (drafted != null) {
      setPrompt(drafted)
      setDraftedWithReference(hasReference)
    }
  }

  // The trap this whole ordering exists to prevent: a prompt drafted with no
  // reference, then a photo attached, then Generate — nano-banana receives the
  // photo and a prompt that never mentions it (and bans photorealistic humans),
  // so the photo is silently ignored.
  const referenceStale = referenceUrl != null && prompt.trim() !== '' && draftedWithReference === false

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
    <div
      className="flex flex-col gap-4 border rule bg-surface p-5"
      data-testid="thumbnail-studio"
      data-state={
        rendering ? 'rendering' : drafting ? 'drafting' : thumbnail?.url ? 'done' : 'idle'
      }
    >
      <div>
        <p className="meta-label">YouTube thumbnail</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
          Describe what you want, attach a reference photo if you want yourself in it,
          draft a prompt, tweak it, then generate the image.
        </p>
      </div>

      {/* Creator notes */}
      <div>
        <label htmlFor="thumb-notes" className="meta-label">
          What should the thumbnail be like?
        </label>
        <textarea
          id="thumb-notes"
          data-testid="thumb-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="e.g. bold, dark navy, show the terminal — excited energy"
          className="mt-1 w-full resize-y rounded-md border border-line bg-surface-dim/20 p-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
        />
      </div>

      {/* Optional reference image — fed to nano-banana alongside the prompt.
          It sits ABOVE the Draft button on purpose: the drafter is told whether
          a reference is attached, and writes the photo into the prompt when it
          is. Attach it afterwards and the prompt describes a self-contained
          illustration, so nano-banana ignores the photo (hence the re-draft
          hint below). */}
      <div>
        <label htmlFor="thumb-reference" className="meta-label">
          Reference image (optional)
        </label>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
          Upload a shot of your face (or a product) <strong>before drafting</strong> and the
          prompt is written around it, instead of a generic illustration.
        </p>
        <input
          id="thumb-reference"
          data-testid="thumb-reference"
          type="file"
          accept="image/*"
          disabled={uploadingReference}
          onChange={handleReferencePick}
          className="mt-2 block w-full text-[13px] text-ink-soft file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-line file:bg-surface-dim/20 file:px-3 file:py-1.5 file:text-[13px] file:text-ink"
        />
        {uploadingReference && (
          <p className="mt-2 text-[13px] text-ink-soft">Uploading…</p>
        )}
        {referenceError && (
          <p role="alert" className="mt-2 text-[13px] text-red-500">
            {referenceError}
          </p>
        )}
        {referencePreview && (
          <div className="mt-2 flex items-center gap-3">
            <img
              src={referencePreview}
              data-testid="thumb-reference-preview"
              alt="Reference image for the thumbnail"
              className="h-20 w-auto rounded-md border border-line"
            />
            <button
              type="button"
              className="pill-ghost"
              onClick={() => { setReferenceUrl(null); setReferenceError(null) }}
            >
              Remove reference
            </button>
          </div>
        )}
      </div>

      {/* Draft — after the reference picker, so the drafted prompt knows about it */}
      <div>
        <button
          type="button"
          className="pill-ghost"
          data-testid="thumb-draft"
          disabled={drafting}
          onClick={handleDraft}
        >
          {drafting ? 'Drafting…' : prompt ? 'Re-draft prompt' : 'Draft prompt'}
        </button>
        {referenceStale && (
          <p role="alert" data-testid="thumb-reference-stale" className="mt-2 text-[13px] text-accent-ink">
            This prompt was drafted without your reference image, so the image model will
            ignore it — re-draft (or edit the prompt to mention the attached photo).
          </p>
        )}
      </div>

      {/* Editable drafted prompt */}
      <div>
        <label htmlFor="thumb-prompt" className="meta-label">
          Image prompt — edit before generating
        </label>
        <textarea
          id="thumb-prompt"
          data-testid="thumb-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={8}
          placeholder={drafting ? 'Drafting a prompt…' : 'Draft a prompt, or paste your own.'}
          className="mt-1 w-full resize-y rounded-md border border-line bg-surface-dim/20 p-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="button"
          className="pill-cta mt-2"
          data-testid="thumb-render"
          disabled={rendering || uploadingReference || !prompt.trim()}
          onClick={() => onRender(notes, prompt, referenceUrl)}
        >
          {rendering ? 'Generating…' : thumbnail ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {/* Result */}
      {signedUrl && (
        <div className="flex flex-col gap-2">
          <img
            src={signedUrl}
            data-testid="thumb-result"
            alt="Generated YouTube thumbnail"
            className="w-full max-w-2xl rounded-md border border-line"
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
