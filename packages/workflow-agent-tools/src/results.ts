/**
 * Every tool answers with an MCP `CallToolResult` (spec 10): a human-readable
 * `content[0].text` plus a machine-readable `structuredContent`. A refusal is
 * `isError: true` whose `structuredContent.errors` is keyed the way spec 07's
 * `window.__workflow.errors` is — by the input that failed, or by the part of
 * the operation that did (`inputs`, `workflow`, `discovery`, `runId`, `step`,
 * `path`, …) — so an agent, a driver and a person are never judged differently.
 */
export interface TextContent {
  type: 'text'
  text: string
}

export interface CallToolResult {
  content: TextContent[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** A successful answer. `structured` is optional: some answers are only prose. */
export function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  }
}

/** A refusal. `errors` is the 07-keyed map; anything else in `structured` rides along (a snapshot, `timedOut`). */
export function errorResult(
  text: string,
  structured: { errors: Record<string, string>; [key: string]: unknown },
): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured, isError: true }
}

export function isErrorResult(result: CallToolResult): boolean {
  return result.isError === true
}
