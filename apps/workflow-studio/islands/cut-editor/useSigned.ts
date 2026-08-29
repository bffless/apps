/**
 * Talking to the host: the bridge types every island component takes, and the one
 * round trip this island needs before it can show anything — `workflow.sign`.
 *
 * An island is injected as `srcdoc` into an `<iframe sandbox="allow-scripts">`, so its
 * origin is opaque: it carries no cookie and a `/api/uploads/...` URL 401s. The clip,
 * the source's WAV and the contact sheets therefore have to be exchanged for presigned
 * URLs over the bridge (`bffless/workflow-hello`'s `line-viewer` is the reference).
 */
import { useEffect, useState } from 'react'

/** A tool result as the host sends it: text blocks, `isError` on a refusal, and the
 *  structured payload `workflow.sign` answers with (`apps/workflow`'s `IslandHost`). */
export interface ToolResult {
  isError?: boolean
  content?: { type: string; text?: string }[]
  structuredContent?: Record<string, unknown>
}

/**
 * The half of `@modelcontextprotocol/ext-apps`' `App` an island *component* uses.
 * `main.tsx` passes the real `App` as the `bridge`, so this interface has to stay
 * structurally satisfied by it — that's what keeps the test double honest (a change
 * to the SDK's signatures fails `tsc`, not just a test).
 */
export interface IslandBridge {
  callServerTool(request: {
    name: string
    arguments?: Record<string, unknown>
  }): Promise<ToolResult>
  getHostContext(): unknown
}

/** A `type: file` step output, as the harness evaluates it into a step's `with`. */
export interface FileRef {
  path: string
  name?: string
  contentType?: string
}

/** The text blocks of a tool result, joined — how the host reports a refusal. */
export function resultText(result: ToolResult): string {
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** What a rejected `callServerTool` — a transport failure, not a tool error — reads as. */
export const failureText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export interface Signed {
  /** Path → presigned URL, for every path that signed. */
  urls: Record<string, string>
  /** The first failure, if any. Partial success still fills `urls`. */
  error: string | null
}

const EMPTY: Signed = { urls: {}, error: null }

/**
 * Presign `paths` on the host, all at once. Every failure mode — a tool `isError`, a
 * rejected promise, a success with no usable URL — becomes a visible `error` rather
 * than a silently blank `<video>`; whatever else signed still renders, because the
 * grid (the point of the step) needs no media at all.
 *
 * `enabled` is the headless switch: an unattended run has no eyes, so it must not wait
 * on — or be stopped by — signing.
 */
export function useSigned(bridge: IslandBridge, paths: string[], enabled = true): Signed {
  // The answers are stored WITH the path list they were asked for, and read back only
  // when that list still matches. So a new set of paths (a re-delivered tool input)
  // reads as "nothing signed yet" without an effect having to reset anything — no
  // synchronous `setState` in an effect body, and no window where the last delivery's
  // URLs are shown against this one's files.
  const [answered, setAnswered] = useState<{ key: string; signed: Signed } | null>(null)
  // The dependency is the path LIST, not its array identity: the caller rebuilds it on
  // every render, and a re-delivered tool input usually names the same files.
  const key = paths.join('\n')

  useEffect(() => {
    const list = key ? key.split('\n') : []
    if (!enabled || list.length === 0) return

    // A superseded delivery's response must not clobber the current one.
    let cancelled = false

    void Promise.all(
      list.map(async (path): Promise<{ path: string; url?: string; error?: string }> => {
        try {
          const result = await bridge.callServerTool({
            name: 'workflow.sign',
            arguments: { path },
          })
          if (result.isError) {
            return { path, error: resultText(result) || `workflow.sign failed for ${path}` }
          }
          const url = result.structuredContent?.url
          if (typeof url !== 'string' || url === '') {
            const detail = resultText(result)
            return { path, error: detail || `workflow.sign returned no url for ${path}` }
          }
          return { path, url }
        } catch (error: unknown) {
          return { path, error: failureText(error) }
        }
      }),
    ).then((results) => {
      if (cancelled) return
      const urls: Record<string, string> = {}
      for (const result of results) if (result.url) urls[result.path] = result.url
      setAnswered({ key, signed: { urls, error: results.find((r) => r.error)?.error ?? null } })
    })

    return () => {
      cancelled = true
    }
  }, [bridge, key, enabled])

  return enabled && answered?.key === key ? answered.signed : EMPTY
}
