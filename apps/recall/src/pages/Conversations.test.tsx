/**
 * Regression test for the "select a conversation -> No messages" bug: CE's
 * ai_handler chat persistence writes each recall_messages row's
 * conversation_id as the useChat-client-generated chat_id, not the
 * recall_conversations record's own UUID (see conversationsApi.ts's
 * ConversationMeta doc comment, and shapeConversations.test.ts). The
 * Conversations viewer must fetch a picked conversation's thread with its
 * chat_id, not its record id, or GET /api/messages always returns zero rows.
 *
 * Follows the fetch-stubbing pattern from AdminVideos.test.tsx (no MSW wired
 * up for Vitest in this app).
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { recallApi } from '../store/recallApi'
import { Conversations } from './Conversations'

// fetchBaseQuery builds a `Request` from the relative `/api/...` URL; in
// jsdom+undici that needs an absolute base (mirrors AdminVideos.test.tsx).
const ORIGIN = 'http://localhost:3000'
const RealRequest = globalThis.Request
class BasedRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/')) input = ORIGIN + input
    super(input, init)
  }
}
beforeAll(() => {
  globalThis.Request = BasedRequest as unknown as typeof Request
})
afterAll(() => {
  globalThis.Request = RealRequest
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function makeStore() {
  return configureStore({
    reducer: { [recallApi.reducerPath]: recallApi.reducer },
    middleware: (gdm) => gdm().concat(recallApi.middleware),
  })
}

function renderPage() {
  const store = makeStore()
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/admin/conversations']}>
        <Conversations />
      </MemoryRouter>
    </Provider>,
  )
}

const CONVERSATIONS = [
  {
    id: '526cc04f-0000-4000-8000-000000000001',
    chat_id: '0yiWMDGDqkgnWtjP',
    title: 'About the pipeline',
    model: 'claude-sonnet-4-5',
    message_count: 2,
    total_tokens: 400,
    createdAt: '2023-11-14T00:00:00.000Z',
  },
  {
    id: '526cc04f-0000-4000-8000-000000000002',
    chat_id: 'anotherClientId1',
    title: null,
    model: 'claude-sonnet-4-5',
    message_count: 1,
    total_tokens: 100,
    createdAt: '2023-11-13T00:00:00.000Z',
  },
]

const MESSAGES = [
  { id: 'm1', role: 'user', content: 'What did I ask?', createdAt: '2023-11-14T00:00:01.000Z' },
  { id: 'm2', role: 'assistant', content: 'Here you go.', createdAt: '2023-11-14T00:00:02.000Z' },
]

function mockFetch() {
  const calls: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input)
    calls.push(url)
    if (url.includes('/api/conversations')) {
      return new Response(JSON.stringify({ conversations: CONVERSATIONS }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/api/messages')) {
      return new Response(JSON.stringify({ messages: MESSAGES }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

describe('Conversations', () => {
  it('queries messages by chat_id, not the record id, when a conversation is picked', async () => {
    const calls = mockFetch()

    renderPage()

    const row = await screen.findByText('About the pipeline')
    fireEvent.click(row)

    await screen.findByText('What did I ask?')

    const messagesCalls = calls.filter((u) => u.includes('/api/messages'))
    expect(messagesCalls).toHaveLength(1)
    expect(messagesCalls[0]).toContain(
      `conversationId=${encodeURIComponent('0yiWMDGDqkgnWtjP')}`,
    )
    expect(messagesCalls[0]).not.toContain('526cc04f-0000-4000-8000-000000000001')
  })

  it('shows the chat_id\'s first 8 chars as a secondary identifier for untitled conversations', async () => {
    mockFetch()

    renderPage()

    await screen.findByText('About the pipeline')
    expect(screen.getByText('Untitled conversation')).toBeInTheDocument()
    expect(screen.getByText('anotherC')).toBeInTheDocument()
  })
})
