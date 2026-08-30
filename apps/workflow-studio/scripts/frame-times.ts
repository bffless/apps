/**
 * `frame-times` — `blog` → step `times`.
 *
 *   with:    { markdown, sources, durations, siblings? }
 *   outputs: { captures: [{ source, time, name, key }] }
 *
 * The blog writer places its images as `![caption](frame:<t>)` tokens, where `<t>`
 * is a second on the GLOBAL (concatenated) clock — the same clock the director read
 * and the blog rule re-stamps its transcript onto (R135). `video/frames` seeks ONE
 * recording at a time, so every token has to come back as a capture LOCAL to the
 * source that owns it. That routing is Studio's `planBlogCaptures` (dedup by
 * timestamp, `globalToLocal` over the cumulative durations, `frame-NN.jpg` in
 * first-appearance order); this step only builds its `SourceLike[]` and renames the
 * result to the pipeline's field names.
 *
 * `captures[].source` is each ref's uploads-relative PATH, never its serve URL —
 * the `video/frames` rule's R129 guard refuses anything outside `workflows/`.
 *
 * Each capture carries BOTH clocks (R140): `time` is the LOCAL second CE seeks to in
 * `source`, and `key` is the GLOBAL second the token was written with. The rule keys
 * its `byTime` map by `key`, so `blog-bundle` — which only ever sees the post's global
 * token times — can look a frame up without re-deriving the timeline. They differ for
 * every recording after the first, and two recordings can share a local second, so
 * keying by `time` would both miss and collide.
 *
 * ## Sibling candidates (apps#429)
 *
 * The writer's second is often *nearly* right but lands on a bad instant — mid-blink,
 * a transition. Studio's blog card answers that with a "Change frame" filmstrip of
 * nearby moments (issue #91), captured in the browser on demand. The port's review
 * island cannot capture anything itself (an opaque-origin frame, no pipeline of its
 * own to poll), so the candidates are captured HERE, up front, in the same
 * `video/frames` job: after the tokens' own frames, one still per grid point of
 * Studio's ±`BLOG_SIBLING_WINDOW` around every token. The grid is the finest of
 * `SIBLING_STEPS` that keeps the whole job under `FRAME_BUDGET` — coarser than
 * Studio's 2 s, because every candidate costs an ffmpeg seek whether or not anyone
 * looks at it — and no candidates at all if even the coarsest would not fit. A
 * candidate is keyed by its own global second, so "Use this frame" is just the token
 * retimed and `blog-bundle` needs no change. `siblings: false` (the workflow passes
 * `!run.headless`) switches them off: an unattended run skips the review island, so
 * capturing frames nobody will pick is pure ffmpeg time.
 */
import type { ScriptContext } from '@bffless/workflow-script'
import {
  BLOG_SIBLING_WINDOW,
  blogReframeFileName,
  planBlogCaptures,
  planBlogSiblings,
  type BlogFrameCapture,
} from 'studio/lib/blog'
import { globalToLocal, totalDuration, type SourceLike } from 'studio/lib/sources'
import { inputError, requireFileRefs, requireNumbers, requireString } from './lib/inputs'

const NAME = 'frame-times'

/**
 * One capture as the `video/frames` rule takes it (`prep.fn.js`). `sibling: true` marks
 * a picker candidate (apps#490): the rule keeps it out of the step's registered File
 * list (`paths`) — it stays reachable by path through `byTime`/`srcs`, which is all the
 * review island and `blog-bundle` need — so a post with a dozen images registers a dozen
 * files, not ~170. A capture without the flag is one of the tokens' own frames.
 */
export type Capture = { source: string; time: number; name: string; key: string; sibling?: true }

/**
 * The most stills one `video/frames` job may ask for. The rule caps each SOURCE at 200
 * (CE's `MAX_STILLS_PER_JOB`, `prep.fn.js`'s `TOO_MANY`), and a post's tokens can all
 * sit in one recording — so one budget for the whole post is the only one that is safe
 * for every layout.
 */
export const FRAME_BUDGET = 200

/**
 * Sibling grid steps, finest first (seconds). 5 s is coarse enough that a whole post
 * fits — 15 tokens × 13 stills — and fine enough to step off a blink or a transition;
 * the ladder only coarsens when the writer used more images than that.
 */
export const SIBLING_STEPS = [5, 10, 15, 30]

/**
 * Plan the sibling captures for a post's tokens: every grid second in Studio's
 * ±`BLOG_SIBLING_WINDOW` around each token at the finest `SIBLING_STEPS` entry that
 * fits `budget` together with the tokens themselves, deduped (two tokens 10 s apart
 * share candidates; a candidate that IS another token is that token's own capture).
 * Ascending by global second. `step` is null when nothing fits — the post gets its
 * frames and no picker.
 */
export function planSiblingCaptures(
  primaries: BlogFrameCapture[],
  timeline: SourceLike[],
  budget = FRAME_BUDGET,
): { step: number | null; captures: Capture[] } {
  if (primaries.length === 0) return { step: null, captures: [] }
  const total = totalDuration(timeline)
  const taken = new Set(primaries.map((p) => p.time))
  for (const step of SIBLING_STEPS) {
    const seconds = new Set<number>()
    for (const p of primaries) {
      for (const t of planBlogSiblings(p.time, total, BLOG_SIBLING_WINDOW, step)) {
        if (!taken.has(t)) seconds.add(t)
      }
    }
    if (primaries.length + seconds.size > budget) continue
    const captures: Capture[] = []
    for (const t of [...seconds].sort((a, b) => a - b)) {
      const loc = globalToLocal(timeline, t)
      if (!loc) continue
      captures.push({ source: loc.sourceId, time: loc.localTime, name: blogReframeFileName(t), key: String(t), sibling: true })
    }
    return { step, captures }
  }
  return { step: null, captures: [] }
}

export default async function frameTimes(ctx: ScriptContext): Promise<Record<string, unknown>> {
  const markdown = requireString(NAME, ctx.inputs, 'markdown')
  const sources = requireFileRefs(NAME, ctx.inputs, 'sources')
  const durations = requireNumbers(NAME, ctx.inputs, 'durations')
  // Absent means on: the interactive run is the one that needs the picker, and the
  // workflow only ever passes `false` (`!run.headless`) to say nobody will open it.
  const siblings = ctx.inputs.siblings !== false

  // Both lists come from the same `per-video` matrix, so a mismatch means a video's
  // outputs are missing — routing the tokens against a short timeline would send a
  // capture to the wrong recording rather than fail.
  if (durations.length !== sources.length) {
    throw inputError(NAME, 'durations', `must have one entry per source (${sources.length}); got ${durations.length}`)
  }

  // `SourceLike` is `{ id, duration }` and `sourceOffsets` lays the sources out in
  // ARRAY order — which is the recordings order the whole workflow uses (the
  // `per-video` matrix, `sourceIndex` on every scene row). The id is the path, so
  // `planBlogCaptures` hands the path straight back as `sourceId`.
  const timeline: SourceLike[] = sources.map((s, i) => ({ id: s.path, duration: durations[i] }))

  const primaries = planBlogCaptures(markdown, timeline)
  const captures: Capture[] = primaries.map((c) => ({
    source: c.sourceId,
    time: c.localTime,
    name: c.fileName,
    key: String(c.time),
  }))
  ctx.log(`${captures.length} frame(s) to capture across ${sources.length} recording(s)`)

  if (siblings) {
    const plan = planSiblingCaptures(primaries, timeline)
    if (plan.step === null) {
      if (primaries.length > 0) ctx.log('no nearby candidates: even a 30 s grid would not fit the frame budget')
    } else {
      ctx.log(`${plan.captures.length} nearby candidate(s) on a ${plan.step} s grid for the Change-frame picker`)
    }
    captures.push(...plan.captures)
  }

  return { captures }
}
