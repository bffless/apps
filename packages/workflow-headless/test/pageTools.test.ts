/**
 * The page-tool helpers against an in-process fake of `document.modelContext`:
 * the `PageLike.evaluate` seam runs the in-page function right here, with a
 * stubbed `window`, so the JSON-string contract the polyfill enforces is what
 * these tests exercise.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DriverError, EXIT } from '../src/errors.js'
import type { PageLike } from '../src/page.js'
import {
  PageToolError,
  WORKFLOW_PAGE_TOOLS,
  callPageTool,
  canonicalPageToolName,
  listPageTools,
  resultText,
  waitForPageTools,
} from '../src/pageTools.js'

interface FakeTool {
  name: string
  description: string
  inputSchema?: unknown
  annotations?: { readOnlyHint?: boolean }
  execute(args: Record<string, unknown>): unknown
}

/** A polyfill-shaped registry: descriptors carry `window`/`origin`, `executeTool` takes a JSON string and answers one. */
class FakeContext {
  readonly calls: Array<{ name: string; argsJson: string }> = []
  constructor(readonly tools: FakeTool[], private readonly answerObjects = false) {}
  async getTools() {
    return this.tools.map((tool) => ({ ...tool, window: 'w', origin: 'https://harness.test' }))
  }
  async executeTool(tool: { name: string }, argsJson: string) {
    this.calls.push({ name: tool.name, argsJson })
    const found = this.tools.find((candidate) => candidate.name === tool.name)
    if (!found) throw new Error(`Tool not found: ${tool.name}`)
    const result = await found.execute(JSON.parse(argsJson))
    return this.answerObjects ? result : JSON.stringify(result)
  }
}

/** A `PageLike` whose `evaluate` runs the function in-process against `globalThis.window`. */
function fakePage(): PageLike {
  return {
    evaluate: async (fn: (arg: unknown) => unknown, arg?: unknown) => fn(arg),
  } as unknown as PageLike
}

const g = globalThis as unknown as { window?: unknown }
let savedWindow: unknown

function install(ctx: FakeContext | null, where: 'document' | 'navigator' = 'document') {
  g.window = {
    document: where === 'document' ? { modelContext: ctx ?? undefined } : {},
    navigator: where === 'navigator' ? { modelContext: ctx ?? undefined } : {},
  }
}

beforeEach(() => {
  savedWindow = g.window
})
afterEach(() => {
  g.window = savedWindow
})

const STATUS: FakeTool = {
  name: 'workflow.status',
  description: 'the snapshot',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
  execute: (args) => ({ content: [{ type: 'text', text: `status of ${String(args.runId ?? 'current')}` }], structuredContent: { args } }),
}
const START: FakeTool = {
  name: 'workflow.start',
  description: 'start',
  annotations: { readOnlyHint: false },
  execute: () => ({ content: [{ type: 'text', text: 'These inputs cannot start a run' }], structuredContent: { errors: { greeting: 'x' } }, isError: true }),
}

describe('listPageTools', () => {
  it('reads getTools() as plain data, from document.modelContext or the navigator alias', async () => {
    install(new FakeContext([STATUS, START]))
    expect(await listPageTools(fakePage())).toEqual([
      { name: 'workflow.status', description: 'the snapshot', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'workflow.start', description: 'start', annotations: { readOnlyHint: false } },
    ])
    install(new FakeContext([STATUS]), 'navigator')
    expect((await listPageTools(fakePage())).map((tool) => tool.name)).toEqual(['workflow.status'])
  })

  it('is empty when the page has no registry', async () => {
    install(null)
    expect(await listPageTools(fakePage())).toEqual([])
  })
})

describe('callPageTool', () => {
  it('passes a JSON string, parses the JSON-string answer, and hands back isError results as answers', async () => {
    const ctx = new FakeContext([STATUS, START])
    install(ctx)
    const status = await callPageTool(fakePage(), 'workflow/status', { runId: 'run_1' })
    expect(ctx.calls).toEqual([{ name: 'workflow.status', argsJson: '{"runId":"run_1"}' }])
    expect(resultText(status)).toBe('status of run_1')
    expect(status.structuredContent).toEqual({ args: { runId: 'run_1' } })

    const refused = await callPageTool(fakePage(), 'workflow.start')
    expect(refused.isError).toBe(true)
    expect(ctx.calls[1]).toEqual({ name: 'workflow.start', argsJson: '{}' })
  })

  it('accepts an object answer from a native implementation', async () => {
    install(new FakeContext([STATUS], true))
    expect(resultText(await callPageTool(fakePage(), 'workflow.status'))).toBe('status of current')
  })

  it('throws PageToolError when the bridge itself fails', async () => {
    install(null)
    await expect(callPageTool(fakePage(), 'workflow.status')).rejects.toThrow(PageToolError)
    install(new FakeContext([STATUS]))
    await expect(callPageTool(fakePage(), 'workflow.nope')).rejects.toThrow('no page tool named workflow.nope')
    install(new FakeContext([{ name: 'odd', description: 'x', execute: () => ({ nope: true }) }], true))
    await expect(callPageTool(fakePage(), 'odd')).rejects.toThrow('not a CallToolResult')
  })
})

describe('waitForPageTools', () => {
  it('resolves once every wanted tool is registered', async () => {
    const ctx = new FakeContext([])
    install(ctx)
    let reads = 0
    const page = {
      evaluate: async (fn: (arg: unknown) => unknown, arg?: unknown) => {
        reads += 1
        if (reads === 3) ctx.tools.push(...WORKFLOW_PAGE_TOOLS.map((name) => ({ name, description: name, execute: () => ({ content: [] }) })))
        return fn(arg)
      },
    } as unknown as PageLike
    const tools = await waitForPageTools(page, { timeoutMs: 10_000, sleep: async () => {} })
    expect(tools.map((tool) => tool.name)).toEqual([...WORKFLOW_PAGE_TOOLS])
    expect(reads).toBe(3)
  })

  it('times out naming what never registered, as a driver TIMEOUT', async () => {
    install(new FakeContext([STATUS]))
    let now = 0
    await expect(
      waitForPageTools(fakePage(), { timeoutMs: 100, names: ['workflow.status', 'workflow.list'], now: () => (now += 60), sleep: async () => {} }),
    ).rejects.toMatchObject({ code: EXIT.TIMEOUT, message: expect.stringContaining('workflow.list') })
    expect(canonicalPageToolName('workflow/list')).toBe('workflow.list')
  })

  it('is a DriverError, so the CLI maps it', async () => {
    install(null)
    await expect(waitForPageTools(fakePage(), { timeoutMs: 0, sleep: async () => {} })).rejects.toBeInstanceOf(DriverError)
  })
})
