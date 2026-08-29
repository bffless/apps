/**
 * `blog-bundle` — `blog` → step `bundle`.
 *
 *   with:    { markdown, title, frames, byTime }
 *   outputs: { zip, post }
 *
 * The portable deliverable (Studio issue #71): one archive holding `post.md` plus an
 * `images/` folder, so the post renders wherever the creator unzips it. Three of
 * Studio's helpers do the work — `rewriteFrameTokens` turns each surviving
 * `frame:<t>` token into a real image, `planBlogBundle` re-homes those images onto
 * relative `images/frame-NN.jpg` paths (deduping a reused frame) and names the
 * archive `<blogSlug(title)>.zip`, and `fflate` packs it. A `Blob`/`File` returned
 * from a `script` step is uploaded by the harness and becomes the `file` output.
 *
 * `byTime` maps a frame's GLOBAL token second → its uploads-relative path. That is a
 * `frame:<t>` token's own clock (R135), because `frame-times` sends the global second
 * along as `captures[].key` and the `video/frames` rule keys the map by it (R140) —
 * so a token is looked up directly here, with no timeline to re-derive. `frames` are
 * the registered File refs for those same paths, which is what `ctx.files.fetch`
 * needs to pull the bytes back same-origin.
 *
 * The "url" baked into the markdown before `planBlogBundle` sees it is deliberately
 * the frame's PATH, not its serve URL: `planBlogBundle` only uses it as a dedup key
 * and immediately replaces it with the relative path, and a path keys back into
 * `frames` without a URL-shape assumption.
 *
 * `planBlogBundle` bundles EVERY `![alt](url)` in the post, not just the ones this
 * step captured — an image the creator pasted into the `edit` form is re-homed to
 * `images/frame-NN.jpg` too. A Worker cannot fetch an arbitrary URL, so any planned
 * image whose bytes are not in hand has its ORIGINAL url put back (Studio's
 * `replaceBlogImageUrl`) and is warned about: the post still renders that image
 * wherever it is read, and the zip never advertises a file it does not hold.
 */
import type { FileRef, ScriptContext } from '@bffless/workflow-script'
import { parseFrameTokens, planBlogBundle, replaceBlogImageUrl, rewriteFrameTokens } from 'studio/lib/blog'
import { strToU8, zipSync } from 'fflate'
import { requireFileRefs, requireRecord, requireString } from './lib/inputs'

const NAME = 'blog-bundle'

/** A frame ref by its uploads-relative path. `byTime`'s values and a ref's `path`
 *  are both what the `video/frames` rule stripped to uploads-relative, so an exact
 *  hit is the norm; the trailing-segment fallback covers a registrar that echoed a
 *  bucket-prefixed key back rather than the key it was sent. */
function refsByPath(frames: FileRef[]): (path: string) => FileRef | undefined {
  const exact = new Map(frames.map((f) => [f.path, f]))
  return (path) => exact.get(path) ?? frames.find((f) => f.path.endsWith(`/${path}`) || path.endsWith(`/${f.path}`))
}

export default async function blogBundle(ctx: ScriptContext): Promise<Record<string, unknown>> {
  const markdown = requireString(NAME, ctx.inputs, 'markdown')
  const title = requireString(NAME, ctx.inputs, 'title')
  const frames = requireFileRefs(NAME, ctx.inputs, 'frames')
  const byTime = requireRecord(NAME, ctx.inputs, 'byTime')
  const findRef = refsByPath(frames)

  // Only fetch what the post actually shows: `byTime` can hold a frame whose token
  // the creator deleted in the `edit` form. Deduped by timestamp — the same moment
  // shown twice is one image in the bundle (`planBlogBundle` dedups by URL too).
  const wanted = [...new Set(parseFrameTokens(markdown).map((t) => t.time))]

  const urlByTime = new Map<number, string>()
  const bytesByPath = new Map<string, Uint8Array>()
  const uncaptured: number[] = []
  for (const time of wanted) {
    if (ctx.signal.aborted) throw new Error(`${NAME}: cancelled`)
    const path = byTime[String(time)]
    // No entry: the capture never happened (a fourth recording — the pipeline seeks
    // three). The token has no image and `rewriteFrameTokens` removes it below;
    // counted so the creator is told.
    if (typeof path !== 'string' || !path) {
      uncaptured.push(time)
      continue
    }
    if (bytesByPath.has(path)) {
      urlByTime.set(time, path)
      continue
    }
    const ref = findRef(path)
    let bytes: Uint8Array | null = null
    if (ref) {
      try {
        const res = await ctx.files.fetch(ref)
        if (res.ok) bytes = new Uint8Array(await res.arrayBuffer())
      } catch {
        bytes = null
      }
    }
    if (!bytes) {
      // One unreadable frame must not cost the creator the whole bundle: drop the
      // image (and its token) and say which one went missing.
      ctx.annotate({
        level: 'warning',
        message: `Left ${ref?.name ?? path} out of the blog bundle — its bytes could not be read back.`,
      })
      continue
    }
    bytesByPath.set(path, bytes)
    urlByTime.set(time, path)
  }

  if (uncaptured.length) {
    ctx.annotate({
      level: 'warning',
      message: `${uncaptured.length} image(s) left out of the post — no frame was captured at ${uncaptured.join('s, ')}s.`,
    })
  }

  const plan = planBlogBundle(rewriteFrameTokens(markdown, urlByTime), title)

  // Everything the plan wants to bundle whose bytes this step never fetched — in
  // practice an image the creator pasted into the `edit` form, whose url is somebody
  // else's and unreachable from an opaque-origin Worker. (A frame whose own fetch
  // failed never gets here: it was dropped from `urlByTime` above, so its token was
  // removed before the plan saw it.) Point each one back at where it really lives
  // rather than at a file the archive will not contain.
  let post = plan.markdown
  const bundled: typeof plan.images = []
  const unreachable: string[] = []
  for (const image of plan.images) {
    if (bytesByPath.has(image.url)) bundled.push(image)
    else {
      unreachable.push(image.url)
      post = replaceBlogImageUrl(post, image.path, image.url)
    }
  }
  if (unreachable.length) {
    ctx.annotate({
      level: 'warning',
      message: `${unreachable.length} image(s) left out of the archive and still linked to where they live: ${unreachable.join(', ')}.`,
    })
  }

  const files: Record<string, Uint8Array> = { [plan.markdownPath]: strToU8(post) }
  for (const image of bundled) {
    const bytes = bytesByPath.get(image.url)
    if (bytes) files[image.path] = bytes
  }

  const zip = zipSync(files)
  ctx.log(`${plan.archiveName}: ${bundled.length} image(s), ${zip.length} bytes`)
  return {
    zip: new File([zip], plan.archiveName, { type: 'application/zip' }),
    post,
  }
}
