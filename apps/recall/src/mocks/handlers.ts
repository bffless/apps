/**
 * MSW handlers for Recall's `/api/*` surface (dev only, `?mocks=on`). Ported
 * from Studio's `src/mocks/handlers.ts` wiring (same file, same purpose: let
 * `pnpm recall:dev` render fully offline, no live BFFless project, no paid
 * Replicate/Anthropic calls) — the handler bodies are new, shaped to Recall's
 * own rule set instead of Studio's upload/scene pipeline.
 *
 * Covers exactly the public surface the home page + video page need
 * (`/api/videos`, `/api/video`, `/api/search`, `/api/chat`), plus a minimal
 * unauthenticated `/api/auth/session` + `/api/admin/videos` so visiting
 * `/admin` shows the sign-in gate instead of hanging on a network call that
 * never resolves. Anything not handled here (uploads, transcribe, index,
 * unpublish, conversations) falls through `onUnhandledRequest: 'bypass'` to
 * the Vite proxy — those flows aren't exercised by the public-page screenshot
 * gate this mock set was built for, and mocking a paid multi-step pipeline
 * end-to-end offline is out of scope here.
 */

import { http, HttpResponse } from 'msw'
import { MOCK_VIDEOS, MOCK_PUBLIC_VIDEO, MOCK_SEARCH_VIDEOS } from './videoFixtures'
import { buildMockChatStream } from './chatStream'

export const handlers = [
  // GET /api/videos -> { videos: PublicVideoMeta[] } — the home page library grid.
  http.get('/api/videos', () => {
    return HttpResponse.json({ videos: MOCK_VIDEOS })
  }),

  // GET /api/video?videoId=<id> -> { video: PublicVideo }. Only `mock-1` (the
  // one fixture with a real transcript) resolves; anything else 404s, mirroring
  // the real rule's "unknown or unpublished id" branch (see `Video.tsx`'s
  // `NotFoundVideo`).
  http.get('/api/video', ({ request }) => {
    const videoId = new URL(request.url).searchParams.get('videoId')
    if (videoId !== MOCK_PUBLIC_VIDEO.videoId) {
      return HttpResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
    }
    return HttpResponse.json({ video: MOCK_PUBLIC_VIDEO })
  }),

  // POST /api/search { q } -> { videos: SearchVideo[] }. Deterministic fixture
  // hits across two videos (mock-1, mock-2) regardless of query text — this is
  // a UI-rendering fixture, not a text-matching reimplementation of the real
  // vector search.
  http.post('/api/search', () => {
    return HttpResponse.json({ videos: MOCK_SEARCH_VIDEOS })
  }),

  // POST /api/chat -> a static SSE reply framed as the AI SDK's UI Message
  // Stream protocol (see `chatStream.ts`), citing `mock-1` so `CitationChip`
  // has a real deep link to seek. GET /api/chat?conversationId=<id> -> no
  // history (the mock never persists conversations), matching the real
  // rule's `{ success, data }` envelope.
  http.post('/api/chat', () => {
    return new HttpResponse(buildMockChatStream(), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
      },
    })
  }),
  http.get('/api/chat', () => {
    return HttpResponse.json({ success: true, data: [] })
  }),

  // Minimal admin surface: an always-logged-out session so `/admin` renders
  // `RequireAdmin`'s sign-in prompt instead of hanging, plus an empty admin
  // video list for completeness.
  http.get('/api/auth/session', () => {
    return HttpResponse.json({ authenticated: false })
  }),
  http.post('/api/auth/session/refresh', () => {
    return new HttpResponse(null, { status: 401 })
  }),
  http.get('/api/admin/videos', () => {
    return HttpResponse.json({ videos: [] })
  }),
]
