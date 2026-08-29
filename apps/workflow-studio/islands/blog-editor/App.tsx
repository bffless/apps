/**
 * `blog-editor` — the `review` step's island (`studio.workflow.yaml`, apps#429).
 *
 * The blog writer's post arrives with `![caption](frame:<t>)` image tokens, and by now
 * the `frames` step has captured a still for every one of them — plus, around each, the
 * nearby candidates Studio's "Change frame" picker offers (`frame-times`). This island
 * renders the post the way Studio's own blog card does — **Studio's `MarkdownBody`**
 * (front matter as a header, figures with their captions) with its `BlogFigure` picker
 * wired to what is already captured — and **Looks good** submits one output:
 *
 * - `post` — the markdown, tokens intact. "Use this frame" is a token retimed to the
 *   chosen candidate's second (`retimeFrameTokens`); `blog-bundle` then resolves it
 *   through the very same `by_time` map, so a swapped frame costs no recapture and no
 *   change downstream. A Markdown view edits the text directly, as the plain form this
 *   island replaces did.
 *
 * Nothing here can be fetched directly: the frame is opaque-origin, so every image is a
 * presigned URL from `workflow.sign` — the tokens' own frames up front, a candidate the
 * moment the picker first shows it, each path signed once (`useFrameUrls`). Until a
 * frame signs its figure shows a placeholder rather than vanishing, and a token with no
 * capture at all (a fourth recording — `video/frames` seeks three) is said so and shown
 * as one too, because the bundle will leave it out.
 *
 * A ```mermaid fence renders as a diagram, as it does in Studio — but the library comes
 * from a pinned CDN URL at runtime (`./mermaid`), never from the bundle, and only when
 * a post actually has a fence; if it can't be fetched the fence shows its source with a
 * note (apps#441). A GFM table renders as a table inside a horizontally scrolling
 * wrapper, so a wide one never widens the column.
 *
 * Headless (`hostContext.bffless.headless`): the workflow declares this step
 * `headless: skip`, so an unattended run never mounts it. If it ever were mounted
 * unattended, the writer's post is submitted as it came, without signing anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownBody } from 'studio/components/Studio/MarkdownBody'
import { createMermaidDiagram } from 'studio/components/Studio/MermaidDiagramView'
import { rewriteFrameTokens, type BlogImageRef } from 'studio/lib/blog'
import { failureText, resultText, signPath, type IslandBridge } from '../lib/useSigned'
import { loadMermaid } from './mermaid'
import { parseArgs, retimeFrameTokens, siblingTimes, timeKey, tokenTimes } from './post'

/** Studio's ```mermaid renderer over the CDN loader — created once, so the library is
 *  fetched and initialised once per island however many fences the post has. */
const Diagram = createMermaidDiagram(loadMermaid)

/**
 * A figure-sized stand-in, as a `data:` URL (the one kind of image an opaque-origin
 * frame can show without asking anyone). No `(`/`)` in the label: `MarkdownBody` finds
 * an image line with `\(([^)]+)\)`, and `encodeURIComponent` leaves parens alone.
 */
function placeholder(label: string): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
    '<rect width="1280" height="720" fill="#e8e6e1"/>' +
    `<text x="640" y="374" text-anchor="middle" font-family="sans-serif" font-size="40" fill="#7a766e">${label}</text>` +
    '</svg>'
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
export const LOADING_FRAME = placeholder('Loading frame…')
export const MISSING_FRAME = placeholder('No frame was captured here')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** True on an unattended run (spec 07): the harness sets it in the host context. */
function isHeadless(bridge: IslandBridge): boolean {
  const context = bridge.getHostContext()
  if (!isRecord(context) || !isRecord(context.bffless)) return false
  return context.bffless.headless === true
}

/**
 * Presigned URLs by path, signed on demand and never re-asked: the tokens' frames are
 * requested as soon as the post is known, a picker's candidates when it opens, and a
 * retimed token's frame is already in hand. (`useSigned` signs a fixed list all at
 * once and answers all-or-nothing; here the list grows as the person browses, and a
 * new candidate must not blank the figures that already loaded.)
 */
function useFrameUrls(bridge: IslandBridge) {
  const asked = useRef(new Map<string, Promise<string>>())
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const sign = useCallback(
    (path: string): Promise<string> => {
      const pending = asked.current.get(path)
      if (pending) return pending
      const request = signPath(bridge, path).then((result) => {
        if (result.url) {
          const url = result.url
          setUrls((prev) => (prev[path] === url ? prev : { ...prev, [path]: url }))
          return url
        }
        // The first failure is the one shown; the rest are the same story.
        setError((prev) => prev ?? result.error ?? `workflow.sign failed for ${path}`)
        return ''
      })
      asked.current.set(path, request)
      return request
    },
    [bridge],
  )

  return { urls, error, sign }
}

// ---------------------------------------------------------------------------

export interface ReviewProps {
  /** The `arguments` of `ui/notifications/tool-input`. */
  args: Record<string, unknown>
  bridge: IslandBridge
}

type View = 'preview' | 'markdown'

export function Review({ args, bridge }: ReviewProps): React.JSX.Element {
  const input = useMemo(() => parseArgs(args), [args])
  const { byTime } = input
  const headless = isHeadless(bridge)

  // The editable state: the writer's post to start with, then whatever the person
  // retimes or types. Deliberately seeded once — a re-delivered `tool-input` (a
  // reconnect, a retry) must not throw away edits made since the first one.
  const [post, setPost] = useState(input.post)
  const [view, setView] = useState<View>('preview')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [sending, setSending] = useState(false)

  const { urls, error: signError, sign } = useFrameUrls(bridge)

  const times = useMemo(() => tokenTimes(post), [post])
  const uncaptured = useMemo(() => times.filter((t) => !byTime[timeKey(t)]), [times, byTime])

  // Sign the tokens' own frames as soon as they are known (and again for a frame a
  // retime brings in — `sign` is a no-op for a path already asked for). Keyed on the
  // path LIST, so a re-render that changes nothing asks for nothing.
  const tokenPaths = useMemo(
    () => times.map((t) => byTime[timeKey(t)]).filter((path): path is string => !!path).join('\n'),
    [times, byTime],
  )
  useEffect(() => {
    if (headless || !tokenPaths) return
    for (const path of tokenPaths.split('\n')) void sign(path)
  }, [headless, tokenPaths, sign])

  // What `MarkdownBody` renders: the post with every token rewritten to its frame's
  // presigned URL — or a placeholder while it signs / when it was never captured —
  // and the sidecar (`url` → global second) that makes a signed figure re-framable.
  const { rendered, frames } = useMemo(() => {
    const urlByTime = new Map<number, string>()
    const frames: BlogImageRef[] = []
    for (const time of times) {
      const path = byTime[timeKey(time)]
      if (!path) {
        urlByTime.set(time, MISSING_FRAME)
        continue
      }
      const url = urls[path]
      if (!url) {
        urlByTime.set(time, LOADING_FRAME)
        continue
      }
      urlByTime.set(time, url)
      frames.push({ url, time })
    }
    return { rendered: rewriteFrameTokens(post, urlByTime), frames }
  }, [post, times, byTime, urls])

  // The picker, over what `frames` already captured: Studio's ±30 s window, but only
  // the seconds that have a still. Signed on first open, cached after.
  const onCaptureSiblings = useCallback(
    async (time: number) => {
      const candidates = await Promise.all(
        siblingTimes(byTime, time).map(async (t) => ({ time: t, thumb: await sign(byTime[timeKey(t)]) })),
      )
      return candidates.filter((c) => c.thumb !== '')
    },
    [byTime, sign],
  )
  // A candidate IS a full-res still already, so its "preview" is the same URL.
  const onPreviewFrame = useCallback(
    async (time: number) => {
      const path = byTime[timeKey(time)]
      return path ? sign(path) : ''
    },
    [byTime, sign],
  )
  // "Use this frame": the figure's current URL says which token second it is; the
  // token is retimed to the chosen second, whose frame is already captured and signed.
  const onReframe = useCallback(
    async (oldUrl: string, time: number) => {
      const from = frames.find((f) => f.url === oldUrl)?.time
      if (from === undefined || !byTime[timeKey(time)]) return false
      setPost((prev) => retimeFrameTokens(prev, from, time))
      return true
    },
    [frames, byTime],
  )

  const submit = useCallback(
    async (markdown: string) => {
      setSending(true)
      try {
        const result = await bridge.callServerTool({
          name: 'workflow.submit',
          arguments: { outputs: { post: markdown } },
        })
        // A refused submit comes back as a tool ERROR, not a throw, and the step stays
        // waiting — so it is shown and the button stays live for another go.
        if (result.isError) setSubmitError(resultText(result) || 'workflow.submit was refused')
        else {
          setSubmitError(null)
          setSubmitted(true)
        }
      } catch (error: unknown) {
        setSubmitError(failureText(error))
      } finally {
        setSending(false)
      }
    },
    [bridge],
  )

  // Headless: submit the writer's post as it came, at once. A claim-once latch —
  // `ontoolinput` can be re-delivered (a reconnect, a retry) and must never submit twice.
  const autoSubmitted = useRef(false)
  useEffect(() => {
    if (!headless || autoSubmitted.current) return
    autoSubmitted.current = true
    void submit(input.post)
  }, [headless, input.post, submit])

  const blank = post.trim() === ''
  const tab = (which: View, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === which}
      data-testid={`island-view-${which}`}
      className={`pill-ghost ${view === which ? 'bg-surface-dim' : ''}`}
      onClick={() => setView(which)}
    >
      {label}
    </button>
  )

  return (
    <div className="min-h-screen bg-surface font-sans text-ink">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b rule px-5 py-3">
        <h1 className="text-[15px] font-semibold text-ink">Review the post</h1>
        <span className="font-mono text-[11px] text-ink-mute">
          {times.length} image{times.length === 1 ? '' : 's'}
        </span>
        <div role="tablist" className="ml-2 flex items-center gap-1">
          {tab('preview', 'Preview')}
          {tab('markdown', 'Markdown')}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {submitted && (
            <span data-testid="island-submitted" className="text-[12px] text-voice-ink">
              Sent to the run.
            </span>
          )}
          <button
            type="button"
            data-testid="island-done"
            className="pill-cta"
            disabled={sending || blank}
            onClick={() => void submit(post)}
          >
            {sending ? 'Sending…' : 'Looks good'}
          </button>
        </div>
      </header>

      {signError && (
        <p
          data-testid="island-sign-error"
          className="border-b rule bg-surface-dim px-5 py-2 text-[12px] text-ink-mute"
        >
          Couldn’t load the post’s frames — {signError}
        </p>
      )}
      {uncaptured.length > 0 && (
        <p
          data-testid="island-uncaptured"
          className="border-b rule bg-surface-dim px-5 py-2 text-[12px] text-ink"
        >
          {uncaptured.length} image{uncaptured.length === 1 ? ' has' : 's have'} no captured frame (at{' '}
          {uncaptured.join(' s, ')} s) and will be left out of the bundle.
        </p>
      )}
      {submitError && (
        <p
          data-testid="island-submit-error"
          className="border-b rule bg-surface-dim px-5 py-2 text-[12px] text-ink"
        >
          Couldn’t send the post — {submitError}
        </p>
      )}

      <main className="mx-auto max-w-6xl px-5 py-6">
        {view === 'preview' ? (
          <div data-testid="island-preview" className="rounded-md border border-line bg-surface p-5">
            <MarkdownBody
              markdown={rendered}
              frames={frames}
              onCaptureSiblings={onCaptureSiblings}
              onPreviewFrame={onPreviewFrame}
              onReframe={onReframe}
              diagram={Diagram}
            />
          </div>
        ) : (
          <textarea
            data-testid="island-markdown"
            aria-label="Post markdown"
            value={post}
            spellCheck={false}
            onChange={(event) => setPost(event.target.value)}
            className="min-h-[70vh] w-full rounded-md border border-line bg-surface p-4 font-mono text-[12.5px] leading-snug text-ink outline-none"
          />
        )}
      </main>
    </div>
  )
}
