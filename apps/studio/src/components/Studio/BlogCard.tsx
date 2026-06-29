import { useState } from 'react'
import { zipSync } from 'fflate'
import type { BlogPost } from '../../store/studioSlice'
import { planBlogBundle } from '../../lib/blog'
import { MarkdownPreview } from './MarkdownPreview'

type Props = {
  /** The generated post (markdown + the direction/script it came from + status),
   *  or null before the first generation. */
  post: BlogPost | null
  /** The video's recommended title — the slug the Blog bundle is named from. */
  title?: string
  /** True while a `/api/blog` job is in flight. */
  generating: boolean
  /** True when the final script has drifted from the script the post was written
   *  against — the post is shown stale, but never auto-regenerated. */
  stale?: boolean
  /** Generate (or regenerate) the post from the current final script + direction. */
  onGenerate: (direction: string) => void
}

/**
 * The Export step's Blog post card (issue #68). A free-text direction input, a
 * Generate button, and a visible status; below it, the generated Markdown in a
 * READ-ONLY preview (no editor). Generation is on-demand only — the card never
 * auto-runs on entering Export. The post + its direction persist on the project
 * working state, so it survives reload and rides `studio_projects` sync.
 *
 * In this slice the post is text-only; inline `frame:<t>` image tokens render as
 * raw text until a later story captures the real frames.
 *
 * When the final script changes after a post was generated (e.g. a scene is
 * re-cut), the card flags the post stale (issue #72) so the producer can choose
 * to Regenerate — staleness is surfaced only, never acted on automatically.
 */
export function BlogCard({ post, title = '', generating, stale = false, onGenerate }: Props) {
  const [direction, setDirection] = useState(post?.direction ?? '')
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState(false)

  const ready = post?.status === 'done' && !!post.markdown

  /**
   * Assemble + download the Blog bundle (issue #71). The pure `planBlogBundle`
   * rewrites the post's image URLs to relative `images/frame-NN.jpg` paths and
   * lists the frames to fetch; here we fetch each one (same-origin serve paths,
   * so the auth cookie rides along), zip them with `post.md`, and save the
   * archive named from the title's slug. Stored (level 0) — the JPEG frames are
   * already compressed and `post.md` is tiny. A failed frame fetch aborts the
   * download with a visible error rather than shipping a broken bundle.
   */
  async function handleDownload() {
    if (!post?.markdown || downloading) return
    setDownloading(true)
    setDownloadError(false)
    try {
      const plan = planBlogBundle(post.markdown, title)
      const files: Record<string, Uint8Array> = {
        [plan.markdownPath]: new TextEncoder().encode(plan.markdown),
      }
      for (const img of plan.images) {
        const res = await fetch(img.url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        files[img.path] = new Uint8Array(await res.arrayBuffer())
      }
      const zipped = zipSync(files, { level: 0 })
      const objectUrl = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }))
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = plan.archiveName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
    } catch {
      setDownloadError(true)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 border rule bg-paper p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="meta-label">Blog post</p>
          <p className="mt-1 text-[13px] text-ink-soft">
            Turn the finished video into a written post — on demand.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill post={post} generating={generating} stale={stale} />
          {ready && (
            <button
              type="button"
              className="pill-ghost"
              disabled={downloading}
              onClick={handleDownload}
            >
              {downloading ? 'Bundling…' : 'Download bundle'}
            </button>
          )}
          <button
            type="button"
            className="pill-ghost"
            disabled={generating}
            onClick={() => onGenerate(direction)}
          >
            {generating ? 'Generating…' : post?.markdown ? 'Regenerate' : 'Generate'}
          </button>
        </div>
      </div>

      <div>
        <label htmlFor="blog-direction" className="meta-label">
          Direction <span className="text-ink-faint">(optional)</span>
        </label>
        <input
          id="blog-direction"
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          placeholder="e.g. friendly tone, lead with the demo, keep it short"
          className="mt-1 w-full rounded-md border border-paper-line bg-paper-deep/20 px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-faint"
        />
      </div>

      {downloadError && (
        <p className="text-[12px] text-rose-600">
          Couldn’t build the bundle — please try again.
        </p>
      )}

      {post?.markdown ? (
        <div className="rounded-md border border-paper-line bg-paper-deep/10 p-4">
          <MarkdownPreview markdown={post.markdown} />
        </div>
      ) : (
        !generating && (
          <p className="text-[13px] text-ink-faint">
            No post yet. Generate one from your final script.
          </p>
        )
      )}
    </div>
  )
}

/** The card's visible status indicator (idle / running / done / stale / error). */
function StatusPill({
  post,
  generating,
  stale,
}: {
  post: BlogPost | null
  generating: boolean
  stale: boolean
}) {
  if (generating) return <span className="text-[12px] text-ink-soft">Writing your post…</span>
  if (post?.status === 'error')
    return <span className="text-[12px] text-rose-600">Generation failed — try again.</span>
  if (post?.status === 'done' && post.markdown) {
    if (stale)
      return (
        <span className="text-[12px] text-amber-600">
          Script changed — regenerate to update.
        </span>
      )
    return <span className="text-[12px] text-ink-soft">Post ready ✓</span>
  }
  return null
}
