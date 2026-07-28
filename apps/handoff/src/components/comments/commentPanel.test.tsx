/**
 * CommentPanel: the ~20rem comment gutter (Task 9, spec §5).
 *
 * Pins the four behaviours the viewer wiring (Task 10) depends on:
 *   - an anchored thread renders as a card positioned from `positions`, on a
 *     canvas translated by `-scrollTop` (so the gutter tracks the document);
 *   - a thread whose id is missing from `positions` falls back to the
 *     "Unanchored" section instead of vanishing;
 *   - resolved threads are hidden until "Show resolved" is toggled;
 *   - a read-only visitor (`canWrite={false}`) gets a "Sign in to comment"
 *     note instead of composers.
 *
 * Store/provider wrapper as in ../nodeDetails.test.tsx; MSW + the
 * `/api/auth/session` stub as in ../../pages/folderBadge.test.tsx, because the
 * cards read `useSession()` for the "is this mine?" affordances.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { handlers, resetMockState, mockCurrentUser } from '../../mocks/handlers'
import { handoffApi } from '../../store/handoffApi'
import { __resetSessionCache } from '../../lib/session'
import type { CommentThread, HandoffComment } from '../../lib/comments'
import { CommentPanel } from './CommentPanel'

const sessionHandler = http.get('/api/auth/session', () => {
  if (!mockCurrentUser) return HttpResponse.json({ authenticated: false, user: null })
  return HttpResponse.json({
    authenticated: true,
    user: { id: mockCurrentUser.id, email: mockCurrentUser.email, role: mockCurrentUser.role },
  })
})

const server = setupServer(...handlers, sessionHandler)

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
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  resetMockState()
  __resetSessionCache()
  server.resetHandlers()
})
afterAll(() => {
  globalThis.Request = RealRequest
  server.close()
})

function makeStore() {
  return configureStore({
    reducer: { [handoffApi.reducerPath]: handoffApi.reducer },
    middleware: (gdm) => gdm().concat(handoffApi.middleware),
  })
}

function comment(over: Partial<HandoffComment> & { id: string }): HandoffComment {
  return {
    nodeId: 'n1',
    parentId: null,
    authorId: 'user-a',
    authorName: 'ann@example.com',
    body: 'a body',
    anchor: { type: 'pin', x: 0.5, y: 0.5 },
    resolved: false,
    resolvedBy: null,
    resolvedMs: null,
    reactions: {},
    deleted: false,
    createdMs: Date.now() - 60_000,
    updatedMs: null,
    ...over,
  }
}

function thread(over: Partial<HandoffComment> & { id: string }, replies: HandoffComment[] = []): CommentThread {
  return { root: comment(over), replies }
}

const noop = () => {}

function renderPanel(props: Partial<React.ComponentProps<typeof CommentPanel>> = {}) {
  const merged: React.ComponentProps<typeof CommentPanel> = {
    nodeId: 'n1',
    threads: [],
    positions: new Map(),
    scrollTop: 0,
    docHeight: 1000,
    activeId: null,
    onActivate: noop,
    canWrite: true,
    draft: null,
    onDraftDone: noop,
    ...props,
  }
  return render(
    <Provider store={makeStore()}>
      <CommentPanel {...merged} />
    </Provider>,
  )
}

describe('CommentPanel', () => {
  it('positions an anchored card from `positions` on a canvas translated by -scrollTop', () => {
    renderPanel({
      threads: [thread({ id: 'c1', body: 'anchored one' })],
      positions: new Map([['c1', 300]]),
      scrollTop: 40,
    })

    const canvas = screen.getByTestId('comment-gutter-canvas')
    expect(canvas).toHaveStyle({ transform: 'translateY(-40px)' })

    const card = screen.getByTestId('gutter-card-c1')
    expect(card).toHaveStyle({ top: '300px' })
    expect(within(card).getByText('anchored one')).toBeInTheDocument()
  })

  it('lists threads missing from `positions` under "Unanchored"', () => {
    renderPanel({
      threads: [
        thread({ id: 'c1', body: 'anchored one' }),
        thread({ id: 'c2', body: 'lost one' }),
      ],
      positions: new Map([['c1', 120]]),
    })

    expect(screen.getByTestId('gutter-card-c1')).toBeInTheDocument()
    expect(screen.queryByTestId('gutter-card-c2')).not.toBeInTheDocument()

    const unanchored = screen.getByTestId('unanchored-section')
    expect(within(unanchored).getByText(/unanchored/i)).toBeInTheDocument()
    expect(within(unanchored).getByText('lost one')).toBeInTheDocument()
    expect(within(unanchored).queryByText('anchored one')).not.toBeInTheDocument()
  })

  it('hides resolved threads until "Show resolved" is toggled', () => {
    renderPanel({
      threads: [
        thread({ id: 'c1', body: 'open one' }),
        thread({ id: 'c2', body: 'settled one', resolved: true }),
      ],
      positions: new Map([
        ['c1', 100],
        ['c2', 400],
      ]),
    })

    expect(screen.getByText('open one')).toBeInTheDocument()
    expect(screen.queryByText('settled one')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText(/show resolved/i))

    expect(screen.getByText('settled one')).toBeInTheDocument()
  })

  it('replaces composers with a "Sign in to comment" note when canWrite is false', () => {
    renderPanel({
      threads: [thread({ id: 'c1', body: 'anchored one' })],
      positions: new Map([['c1', 100]]),
      canWrite: false,
    })

    expect(screen.getByText('Sign in to comment')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/reply/i)).not.toBeInTheDocument()
  })

  it('shows a reply composer on each card when canWrite is true', () => {
    renderPanel({
      threads: [thread({ id: 'c1', body: 'anchored one' })],
      positions: new Map([['c1', 100]]),
      canWrite: true,
    })

    expect(screen.getByPlaceholderText(/reply/i)).toBeInTheDocument()
    expect(screen.queryByText('Sign in to comment')).not.toBeInTheDocument()
  })

  it('marks an edited comment and renders a soft-deleted root as "Comment deleted"', () => {
    renderPanel({
      threads: [
        thread({ id: 'c1', body: 'tweaked', updatedMs: Date.now() }),
        thread({ id: 'c2', body: '', deleted: true }, [comment({ id: 'r1', parentId: 'c2', body: 'orphan reply' })]),
      ],
      positions: new Map([
        ['c1', 100],
        ['c2', 400],
      ]),
    })

    expect(within(screen.getByTestId('gutter-card-c1')).getByText(/\(edited\)/)).toBeInTheDocument()

    const husk = screen.getByTestId('gutter-card-c2')
    expect(within(husk).getByText('Comment deleted')).toBeInTheDocument()
    // The husk keeps its replies — that is the whole point of the soft delete.
    expect(within(husk).getByText('orphan reply')).toBeInTheDocument()
    // …and offers no author actions of its own.
    expect(within(husk).queryByRole('button', { name: 'Comment actions' })).not.toBeInTheDocument()
  })

  it('offers the ⋯ Edit/Delete menu only on your own comment', async () => {
    renderPanel({
      threads: [
        thread({ id: 'c1', body: 'mine', authorId: 'user-owner' }),
        thread({ id: 'c2', body: 'theirs', authorId: 'someone-else' }),
      ],
      positions: new Map([
        ['c1', 100],
        ['c2', 400],
      ]),
    })

    // The menu is gated on the resolved session, so it appears asynchronously.
    const mine = screen.getByTestId('gutter-card-c1')
    expect(await within(mine).findByRole('button', { name: 'Comment actions' })).toBeInTheDocument()

    const theirs = screen.getByTestId('gutter-card-c2')
    expect(within(theirs).queryByRole('button', { name: 'Comment actions' })).not.toBeInTheDocument()

    fireEvent.click(within(mine).getByRole('button', { name: 'Comment actions' }))
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
  })

  it('reflects the session user in the reaction row and patches with a react op', async () => {
    const seen: unknown[] = []
    server.use(
      http.patch('/api/comments', async ({ request }) => {
        const body = await request.json()
        seen.push(body)
        return HttpResponse.json({ comment: { id: 'c1', nodeId: 'n1', body: 'reactable' } })
      }),
    )

    renderPanel({
      threads: [
        thread({ id: 'c1', body: 'reactable', reactions: { '👍': ['user-owner'], '🎉': ['other'] } }),
      ],
      positions: new Map([['c1', 100]]),
    })

    // aria-pressed is derived from `session.user.id` being in the emoji bucket.
    const mine = await screen.findByRole('button', { name: '👍 1', pressed: true })
    const theirs = screen.getByRole('button', { name: '🎉 1' })
    expect(theirs).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(mine)
    await screen.findByRole('button', { name: '👍 1' })
    expect(seen).toContainEqual({ id: 'c1', op: 'react', emoji: '👍' })
  })

  it('renders a draft composer card at the draft anchor', () => {
    renderPanel({
      draft: { anchorY: 240, anchor: { type: 'pin', x: 0.25, y: 0.25 } },
    })

    const draftCard = screen.getByTestId('gutter-card-__draft__')
    expect(draftCard).toHaveStyle({ top: '240px' })
    expect(within(draftCard).getByPlaceholderText(/add a comment/i)).toBeInTheDocument()
  })
})
