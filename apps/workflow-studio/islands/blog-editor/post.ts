/**
 * The pure half of the `blog-editor` island: narrowing the step's `with`, and the
 * string/number arithmetic between the post's `frame:<t>` tokens and the `by_time`
 * map the `frames` step produced. Everything here is testable without a DOM.
 */
import { BLOG_SIBLING_WINDOW, parseFrameTokens } from 'studio/lib/blog'

/** Global token second (as `by_time` keys it — `String(t)`) → the captured frame's
 *  uploads-relative path. Holds the tokens' own frames AND the picker's candidates. */
export type ByTime = Record<string, string>

export interface ReviewInput {
  post: string
  byTime: ByTime
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * `ui/notifications/tool-input` delivers whatever the harness evaluated — the step's
 * `with` minus `src`/`title`/`display`. It is JSON off a live run, so it is narrowed
 * rather than cast: a `by_time` that came back as `[]` (a frames pipeline that
 * returned nothing) or a missing `post` must degrade to a reviewable page, not a
 * blank frame.
 */
export function parseArgs(args: Record<string, unknown>): ReviewInput {
  const byTime: ByTime = {}
  if (isRecord(args.by_time)) {
    for (const [key, path] of Object.entries(args.by_time)) {
      if (typeof path === 'string' && path !== '' && Number.isFinite(Number(key))) byTime[key] = path
    }
  }
  return { post: typeof args.post === 'string' ? args.post : '', byTime }
}

/** The `by_time` key for a token second — the same `String(t)` `frame-times` sent
 *  as `captures[].key`, so a `frame:83.5` token and its capture agree. */
export const timeKey = (time: number): string => String(time)

/** The distinct token seconds in a post, in first-appearance order. */
export function tokenTimes(markdown: string): number[] {
  return [...new Set(parseFrameTokens(markdown).map((t) => t.time))]
}

/** Every captured global second, ascending. */
export function capturedTimes(byTime: ByTime): number[] {
  return Object.keys(byTime)
    .map(Number)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)
}

/**
 * The picker's candidates for a figure at `time`: every captured second within
 * Studio's ±`BLOG_SIBLING_WINDOW`, ascending, `time` itself included when it was
 * captured (so the current frame sits in the strip, as it does in Studio).
 */
export function siblingTimes(byTime: ByTime, time: number, window = BLOG_SIBLING_WINDOW): number[] {
  return capturedTimes(byTime).filter((t) => Math.abs(t - time) <= window)
}

/**
 * Retime every `![caption](frame:<from>)` token to `frame:<to>` — the island's "Use
 * this frame". The post keeps its tokens (the bundle resolves them through `by_time`
 * exactly as it would the original), so a swap is a change of second, nothing more. A
 * second reused by two images swaps both, as Studio's `replaceBlogImageUrl` does.
 */
export function retimeFrameTokens(markdown: string, from: number, to: number): string {
  if (from === to) return markdown
  let out = markdown
  for (const token of parseFrameTokens(markdown)) {
    if (token.time !== from) continue
    out = out.split(token.raw).join(`![${token.caption}](frame:${to})`)
  }
  return out
}
