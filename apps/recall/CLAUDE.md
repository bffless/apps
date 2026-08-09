# CLAUDE.md — Recall

Guidance for Claude Code when working in the Recall app. Recall is video transcript RAG search &
chat: an admin uploads videos (or points at existing files), transcripts get chunked and embedded
into CE's pgvector, and a public site searches and chats over them with second-exact YouTube deep
links. A sibling app to Studio and Reader in this pnpm monorepo.

## Commands (run from repo root or with `--filter recall`)

- `pnpm --filter recall dev` — Vite dev server with HMR (`?mocks=on` to run fully offline, see below)
- `pnpm --filter recall build` — type-check (`tsc -b`) then `vite build` into `apps/recall/dist/`
- `pnpm --filter recall lint` — ESLint (flat config)
- `pnpm --filter recall test:run` — single Vitest run (CI mode); `test` for watch
- Single file: `pnpm --filter recall exec vitest run src/lib/chunker.test.ts`

Root aliases exist too: `pnpm recall:dev|build|lint|test`.

## Architecture

**One authored BFFless proxy rule set, 22 rules, no app server.** `.bffless/proxy-rules/recall/` —
see `bffless/README.md` for import steps + manual admin-panel prerequisites (Replicate, Anthropic,
bucket CORS). Locally, unhandled `/api/*` falls through the Vite proxy to `j5s.dev`.

**Ingest is staged**, one step at a time, each an admin-only rule:

1. **Upload** — presigned direct-to-bucket PUT for the source video and/or extracted audio
   (`/api/uploads/{source,audio}/{prepare,register}`), recorded on the `recall_videos` row.
2. **Transcribe** (`/api/transcribe`) — enqueue-only: WhisperX runs in the pipeline's postSteps
   (can't fit the 30s edge timeout), writes `transcript` (JSON `{words:[{text,start,end}], text}`)
   + flips `status` to `transcribed`/`error`. Polled via `/api/recall/job?id=`.
3. **Publish = index** (`/api/index`) — the *only* way transcript chunks get embedded. A draft or
   merely-transcribed video has **zero embeddings**, so the schema-wide `rag-search` chat tool
   structurally cannot surface it — there's no separate "hide from search" flag to forget to set.
   Chunks the transcript (`chunk.fn.js`), embeds each chunk (Replicate
   `nateraw/bge-large-en-v1.5`), stores via `embed_store`, flips `status` to `published`.
   `/api/unpublish` is the inverse: deletes the video's embeddings, flips back to `transcribed`.

**Chunker params** (`rules/api/index/post/chunk.fn.js`, TDD'd against real timing math in
`src/lib/chunker.test.ts` via the fn harness): windows target **45s**, capped at **120 words**
(whichever closes the window first), with a **10s time overlap** into the next window or a
**24-word overlap cap** when the window closed on the word cap instead — a unified "restart floor"
formula (`j = max(overlapIdx, startIdx + (windowLen - 24))`) keeps every word-capped close's
overlap ≤24 words even at dense speech. Each chunk's text is prefixed `[t=<sec>s] ` (its start
time) — see "A note on the `[t=Ns]` prefix" in `bffless/README.md` for why that prefix exists and
when it's safe to remove.

**Search & chat share one embedding space.** `/api/search` embeds the query with the same pinned
model and runs `vector_search`; `/api/chat` is `ai_handler` (Haiku 4.5, SSE) with the `rag-search`
plugin's `search_videos` tool doing the identical embed+search under the hood. Both prefer
`chunkMetadata.start` when CE returns it, falling back to parsing the chunk's `[t=Ns]` prefix.
Changing the embedding model requires re-publishing every video — see the README's language-swap
recipe.

## CE facts learned building this app

Worth knowing before touching any `.fn.js` or `rule.yaml`:

- **Fn contract**: a pipeline `*.fn.js` declares `function handler({ user, request, steps,
  deployment, utils }) { ...; return {...} }`. The runtime evaluates the source, then calls
  `handler(ctx)` and uses the return value directly as the step's output — there's no `var output`
  convention. `src/test/fnHarness.ts` runs fns exactly this way (`loadFnSource` + `runFn`), so
  `.fn.js` logic gets real Vitest coverage without a live BFFless instance.
- **`condition` is a single field path (or its negation) only** — `steps.prep.ok` or
  `!steps.prep.ok`, no boolean composition (`a && b` isn't supported). Any AND-of-conditions has to
  be folded into its own step first (e.g. `storeCheck.fn.js` combines "did zip succeed" and "did
  embed_store actually store rows" into one `{ok, notOk}` before anything conditions on it) — see
  `rules/api/index/post/*Check.fn.js` for the pattern (`chunkCheck`, `zipCheck`, `storeCheck`).
- **No array-literal footgun, actually**: CE's expression evaluator only string-parses values that
  are strings at YAML-parse time; a bare `chunks: []` already parses to a real array and passes
  through untouched. (An earlier draft of this codebase worked around a suspected array-literal
  bug that turned out not to exist — see task-8's fix report in the SDD ledger if curious.)
- **postSteps never abort on a failure.** A failed step's `success:false` result never lands in
  `context.stepOutputs`, so a downstream step conditioned on that step's `.ok` field sees neither
  true nor false — it just never runs. Every terminal branch (job done/error, video
  published/error-back) has to be reached by an explicit `*Check` step's condition, not inferred
  from "the earlier step must have succeeded because we got this far."

## Layout

- **State**: server state lives entirely in RTK Query (`recallApi` + injected endpoints in
  `store/videosApi.ts`, `store/searchApi.ts`, `store/conversationsApi.ts`) — no redux-persist,
  unlike Studio; there's no durable client-side business state to persist. Auth/session handling
  (`src/lib/auth.ts`) mirrors Reader's (Recall is served on a subdomain of the primary domain, same
  SuperTokens-cookie topology), not Studio's.
- **Pure logic** in `src/lib/*`, unit-tested next to source: `chunker` logic lives server-side in
  the rule's own `.fn.js` (tested via the harness, see above), while `youtube.ts` (id/timestamp
  extraction), `upload.ts`/`audio.ts` (presigned upload, WAV extraction) are ordinary TS modules.
- **Pages**: `Home` (search/chat tabs + published-video library grid, public), `Video` (transcript
  + click-to-seek player, public), `AdminVideos`/`AdminVideo` (CRUD + ingest panel, admin-gated by
  `RequireAdmin`), `Conversations` (read-only chat transcript viewer, admin-gated).
- **Chat** (`src/components/chat/`) uses `@ai-sdk/react`'s `useChat` + `DefaultChatTransport`
  against `/api/chat` — the AI SDK's UI Message Stream protocol (SSE, `text-start`/`text-delta`/
  `text-end`/`finish` chunks, `x-vercel-ai-ui-message-stream: v1` header). Citation links the model
  writes (`[<title> @ mm:ss](youtube-url&t=<sec>s)`) render as `CitationChip`s that seek the shared
  player instead of navigating away.
- **App shell**: `src/App.tsx` — `/` (Home), `/video/:videoId`, `/admin`, `/admin/video/:videoId`,
  `/admin/conversations`. `src/main.tsx` wires the store + the MSW mock bootstrap (see below).

## Testing

- **Component/hook tests**: Vitest + Testing Library, standard RTK Query mocking.
- **Pipeline `.fn.js` tests**: `src/test/fnHarness.ts`'s `loadFnSource`/`runFn` load a rule's
  `.fn.js` source straight from `.bffless/proxy-rules/recall/rules/...` and invoke its `handler`
  the way CE's `function_handler` does — no server, no mocking the CE runtime, and the test breaks
  immediately if the rule's file layout moves. See `src/lib/chunker.test.ts`, `gate.test.ts`,
  `shapeVideosList.test.ts`, `shapeVideoGet.test.ts`, `shapeSearch.test.ts`, `shapeMessages.test.ts`,
  `shapeConversations.test.ts` for the pattern across every shape/gate fn in the rule set.
- **MSW mocks** (`src/mocks/`): `?mocks=on`/`?mocks=off` in the URL (persisted to localStorage)
  toggles a dev-only service worker that fakes `/api/videos`, `/api/video`, `/api/search`,
  `/api/chat` (a static SSE reply), and a minimal unauthenticated `/api/auth/session` so
  `pnpm recall:dev` renders the whole public site with no live BFFless project and no paid
  Replicate/Anthropic calls. Ported from Studio's `src/mocks/` wiring — same master-switch
  resolution order (query param → localStorage → `VITE_MOCKS` env → default on), same
  `onUnhandledRequest: 'bypass'` so anything unmocked still reaches the Vite proxy.
