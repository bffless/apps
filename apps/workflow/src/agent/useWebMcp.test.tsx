/**
 * The registration effect against a fake registry (spec 10 §Testing): every
 * catalog tool registered once, bound to a live executor, and gone on unmount.
 */
import { render, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { TOOL_NAMES } from '@bffless/workflow-agent-tools'
import { makeStore } from '../store'
import { AgentTools } from './AgentTools'
import type { ModelContextLike, RegisteredToolInput } from './registry'

class FakeRegistry implements ModelContextLike {
  readonly tools = new Map<string, RegisteredToolInput>()
  registrations = 0
  registerTool(tool: RegisteredToolInput, options?: { signal?: AbortSignal }): void {
    this.registrations += 1
    this.tools.set(tool.name, tool)
    options?.signal?.addEventListener('abort', () => this.tools.delete(tool.name), { once: true })
  }
  getTools() {
    return [...this.tools.values()].map((tool) => ({ name: tool.name, description: tool.description }))
  }
}

function mount(resolve: () => Promise<ModelContextLike | null>) {
  const store = makeStore()
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/hello/hello']}>
        <AgentTools resolve={resolve} />
      </MemoryRouter>
    </Provider>,
  )
}

describe('AgentTools / useWebMcp', () => {
  it('registers every catalog tool once, with its annotations, and unregisters on unmount', async () => {
    const registry = new FakeRegistry()
    const view = mount(async () => registry)

    await waitFor(() => expect(registry.tools.size).toBe(TOOL_NAMES.length))
    expect([...registry.tools.keys()].sort()).toEqual([...TOOL_NAMES].sort())
    expect(registry.tools.get('workflow.list')?.annotations?.readOnlyHint).toBe(true)
    expect(registry.tools.get('workflow.start')?.annotations?.readOnlyHint).toBe(false)
    expect(registry.tools.get('workflow.describe')?.inputSchema).toMatchObject({ required: ['impl', 'workflow'] })

    // A re-render registers nothing more (zero toolchange churn).
    view.rerender(
      <Provider store={makeStore()}>
        <MemoryRouter initialEntries={['/hello/hello']}>
          <AgentTools resolve={async () => registry} />
        </MemoryRouter>
      </Provider>,
    )
    expect(registry.registrations).toBe(TOOL_NAMES.length)

    view.unmount()
    expect(registry.tools.size).toBe(0)
  })

  it('binds each tool to a live executor that answers a CallToolResult', async () => {
    const registry = new FakeRegistry()
    mount(async () => registry)
    await waitFor(() => expect(registry.tools.size).toBe(TOOL_NAMES.length))

    const result = (await registry.tools.get('workflow.status')!.execute({})) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe('No run is on this page — pass runId')

    // A host that hands a non-object (the polyfill parses JSON; a native one may not) is treated as no arguments.
    const bare = (await registry.tools.get('workflow.status')!.execute(undefined as unknown as Record<string, unknown>)) as { isError?: boolean }
    expect(bare.isError).toBe(true)
  })

  it('registers nothing when there is no registry, and logs nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mount(async () => null)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(error).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('registers nothing when the registry resolves after unmount', async () => {
    const registry = new FakeRegistry()
    let release!: (value: ModelContextLike) => void
    const view = mount(() => new Promise<ModelContextLike>((resolve) => (release = resolve)))
    view.unmount()
    release(registry)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(registry.registrations).toBe(0)
  })

  it('logs a registration the registry refused, and keeps going', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const registry = new FakeRegistry()
      const refusing: ModelContextLike = {
        registerTool: (tool, options) => {
          if (tool.name === 'workflow.sign') throw new Error('no signing here')
          registry.registerTool(tool, options)
        },
        getTools: () => registry.getTools(),
      }
      mount(async () => refusing)
      await waitFor(() => expect(registry.tools.size).toBe(TOOL_NAMES.length - 1))
      await waitFor(() => expect(error).toHaveBeenCalledWith('[agent] workflow.sign was not registered', expect.any(Error)))
    } finally {
      error.mockRestore()
    }
  })
})
