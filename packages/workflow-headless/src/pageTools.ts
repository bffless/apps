/**
 * The harness page's WebMCP tools, driven from the outside (spec 10 §Testing
 * without an agent host): `document.modelContext.getTools()` and
 * `executeTool()` through `page.evaluate`, so a walk can prove the catalog
 * against a real deployment with no agent host in the loop.
 *
 * Written against the shape the page always has — the `@mcp-b/webmcp-polyfill`
 * the harness installs when the browser has no native WebMCP — which is
 * Chrome-shaped: `executeTool` takes the **descriptor object** `getTools()`
 * returned and a **JSON string** of arguments, and answers a JSON string of
 * the `CallToolResult`. A native implementation that answers an object passes
 * through untouched; both are feature-tested in the page, never assumed.
 *
 * The in-page functions are self-contained (no closures): Playwright
 * serialises them as source, so everything they need arrives as the argument.
 */
import { DriverError, EXIT } from './errors.js'
import type { PageLike } from './page.js'

export interface PageToolInfo {
  name: string
  description: string
  inputSchema?: unknown
  annotations?: { readOnlyHint?: boolean }
}

export interface PageToolResult {
  content: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** The bridge itself failed — no registry on the page, no such tool, an answer that is not a result. `isError` results are *not* this: the caller reads those. */
export class PageToolError extends Error {
  readonly result: PageToolResult | undefined
  constructor(message: string, result?: PageToolResult) {
    super(message)
    this.name = 'PageToolError'
    this.result = result
  }
}

/** The eleven catalog names — what `waitForPageTools` waits for by default. Kept here, not imported: the driver must not depend on the catalog to read a page. */
export const WORKFLOW_PAGE_TOOLS: readonly string[] = [
  'workflow.list',
  'workflow.describe',
  'workflow.start',
  'workflow.status',
  'workflow.await',
  'workflow.runs',
  'workflow.submitStep',
  'workflow.outputs',
  'workflow.sign',
  'workflow.cancel',
  'workflow.resume',
]

/** `workflow/start` → `workflow.start`, the catalog's slash tolerance (04). */
export function canonicalPageToolName(name: string): string {
  return name.replace(/\//g, '.')
}

type ToolsAnswer = { missing: 'modelContext' } | { tools: PageToolInfo[] }
type CallAnswer = { missing: 'modelContext' | 'tool' } | { raw: unknown }

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** `getTools()` as plain data (`window`/`origin` fields dropped), or `[]` when the page has no registry. */
export async function listPageTools(page: PageLike): Promise<PageToolInfo[]> {
  const answer = await page.evaluate<ToolsAnswer>(async () => {
    const w = window as unknown as {
      document: { modelContext?: { getTools(): Promise<unknown[]> | unknown[] } }
      navigator: { modelContext?: { getTools(): Promise<unknown[]> | unknown[] } }
    }
    const ctx = w.document.modelContext ?? w.navigator.modelContext
    if (!ctx) return { missing: 'modelContext' as const }
    const tools = (await ctx.getTools()) as Array<Record<string, unknown>>
    return {
      tools: tools.map((tool) => ({
        name: String(tool.name),
        description: typeof tool.description === 'string' ? tool.description : '',
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        ...(tool.annotations && typeof tool.annotations === 'object'
          ? { annotations: { readOnlyHint: (tool.annotations as { readOnlyHint?: boolean }).readOnlyHint === true } }
          : {}),
      })),
    }
  })
  return 'tools' in answer ? answer.tools : []
}

/**
 * Poll until every name in `names` is registered. The page registers its
 * tools from an effect after the first render, and the polyfill installs
 * through a dynamic import, so a driver that reads too early sees none — the
 * same reason `waitForStart` polls for `runId` rather than reading the global
 * the instant navigation lands (07).
 */
export async function waitForPageTools(
  page: PageLike,
  o: { timeoutMs: number; names?: readonly string[]; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<PageToolInfo[]> {
  const names = o.names ?? WORKFLOW_PAGE_TOOLS
  const pollMs = o.pollMs ?? 250
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? realSleep
  const deadline = now() + o.timeoutMs
  for (;;) {
    const seen = await listPageTools(page)
    const registered = new Set(seen.map((tool) => tool.name))
    if (names.every((name) => registered.has(name))) return seen
    if (now() >= deadline) {
      const missing = names.filter((name) => !registered.has(name))
      throw new DriverError(
        `timed out after ${o.timeoutMs} ms waiting for page tools ${missing.join(', ')} (registered: ${[...registered].join(', ') || 'none'})`,
        EXIT.TIMEOUT,
      )
    }
    await sleep(pollMs)
  }
}

function isResult(value: unknown): value is PageToolResult {
  return value !== null && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content)
}

/**
 * Call one page tool. Resolves to the `CallToolResult` whether or not it is
 * an `isError` — a refusal is an answer the caller asserts on. Throws
 * `PageToolError` only when the bridge itself fails.
 */
export async function callPageTool(page: PageLike, name: string, args: Record<string, unknown> = {}): Promise<PageToolResult> {
  const canonical = canonicalPageToolName(name)
  const answer = await page.evaluate<CallAnswer, { name: string; argsJson: string }>(
    async ({ name, argsJson }) => {
      type Ctx = {
        getTools(): Promise<Array<{ name: string }>> | Array<{ name: string }>
        executeTool(tool: unknown, argsJson: string): Promise<unknown>
      }
      const w = window as unknown as { document: { modelContext?: Ctx }; navigator: { modelContext?: Ctx } }
      const ctx = w.document.modelContext ?? w.navigator.modelContext
      if (!ctx) return { missing: 'modelContext' as const }
      const tools = await ctx.getTools()
      const tool = tools.find((candidate) => candidate.name === name)
      if (!tool) return { missing: 'tool' as const }
      const raw = await ctx.executeTool(tool, argsJson)
      return { raw: typeof raw === 'string' ? JSON.parse(raw) : raw }
    },
    { name: canonical, argsJson: JSON.stringify(args) },
  )
  if ('missing' in answer) {
    throw new PageToolError(
      answer.missing === 'modelContext' ? 'the page has no modelContext registry' : `no page tool named ${canonical}`,
    )
  }
  if (!isResult(answer.raw)) throw new PageToolError(`${canonical} answered something that is not a CallToolResult`)
  return answer.raw
}

/** `content[0].text` of a result, or `''`. */
export function resultText(result: PageToolResult): string {
  return result.content.find((part) => part.type === 'text')?.text ?? ''
}
