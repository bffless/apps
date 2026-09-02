/**
 * A relayed pipeline answer in the island's vocabulary — the two private
 * helpers of `islands/IslandHost.ts` (`structured`, `httpToolError`), restated
 * because the bundle may not import the host (it would drag the ext-apps
 * bridge into the sandbox); `toolResults.test.ts` pins the shapes.
 */
import { errorResult, textResult, type CallToolResult } from '@bffless/workflow-agent-tools'

/**
 * MCP's `structuredContent` is an object, so a pipeline that answers with a
 * bare array/number (or with text) is wrapped rather than dropped: a string
 * body becomes `{ text }`, anything else non-object `{ value }` (04, Decision 10).
 */
export function structured(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  return typeof body === 'string' ? { text: body } : { value: body }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A 2xx pipeline answer as the island reads it: the JSON as text, the object as structuredContent. */
export function pipelineResult(body: unknown): CallToolResult {
  return textResult(JSON.stringify(body), structured(body))
}

/**
 * A non-2xx pipeline answer: the same `code`/`message` extraction the pipeline
 * step adapter applies (03), flattened into one line because MCP has no error
 * object — plus the raw status under `_meta.bffless` for an island that wants
 * to branch on it (04, Decision 10).
 */
export function pipelineError(url: string, status: number, body: unknown): CallToolResult & { _meta: { bffless: { status: number } } } {
  const b = structured(body)
  const code = str(b.code) ?? str(b.error) ?? `HTTP_${status}`
  const message = str(b.message) ?? str(b.error) ?? str(typeof body === 'string' ? body : undefined) ?? `${url} failed with status ${status}`
  const text = `${code}: ${message}`
  return { ...errorResult(text, { errors: { pipeline: text }, status }), _meta: { bffless: { status } } }
}
