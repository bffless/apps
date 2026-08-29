/**
 * `frame-times` — `blog` → step `times`.
 *
 *   with:    { markdown, sources, durations }
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
 */
import type { ScriptContext } from '@bffless/workflow-script'
import { planBlogCaptures } from 'studio/lib/blog'
import type { SourceLike } from 'studio/lib/sources'
import { inputError, requireFileRefs, requireNumbers, requireString } from './lib/inputs'

const NAME = 'frame-times'

export default async function frameTimes(ctx: ScriptContext): Promise<Record<string, unknown>> {
  const markdown = requireString(NAME, ctx.inputs, 'markdown')
  const sources = requireFileRefs(NAME, ctx.inputs, 'sources')
  const durations = requireNumbers(NAME, ctx.inputs, 'durations')

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

  const captures = planBlogCaptures(markdown, timeline).map((c) => ({
    source: c.sourceId,
    time: c.localTime,
    name: c.fileName,
    key: String(c.time),
  }))
  ctx.log(`${captures.length} frame(s) to capture across ${sources.length} recording(s)`)
  return { captures }
}
