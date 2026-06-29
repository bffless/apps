import { useState } from 'react'
import type { BlogPost } from '../../store/studioSlice'
import { MarkdownPreview } from './MarkdownPreview'

type Props = {
  /** The generated post (markdown + the direction/script it came from + status),
   *  or null before the first generation. */
  post: BlogPost | null
  /** True while a `/api/blog` job is in flight. */
  generating: boolean
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
 */
export function BlogCard({ post, generating, onGenerate }: Props) {
  const [direction, setDirection] = useState(post?.direction ?? '')

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
          <StatusPill post={post} generating={generating} />
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

/** The card's visible status indicator (idle / running / done / error). */
function StatusPill({ post, generating }: { post: BlogPost | null; generating: boolean }) {
  if (generating) return <span className="text-[12px] text-ink-soft">Writing your post…</span>
  if (post?.status === 'error')
    return <span className="text-[12px] text-rose-600">Generation failed — try again.</span>
  if (post?.status === 'done' && post.markdown)
    return <span className="text-[12px] text-ink-soft">Post ready ✓</span>
  return null
}
