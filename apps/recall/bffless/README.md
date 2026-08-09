# Recall backend — BFFless proxy rule set

Recall (video transcript RAG search & chat) has no app server. Its `/api/*` endpoints are a
**BFFless proxy rule set**. To run Recall against your own BFFless project you import that rule
set and attach it to the alias serving the app.

Recall's rule set is **authored** under
[`apps/recall/.bffless/proxy-rules/recall/`](../.bffless/proxy-rules/recall/) — that's the source
of truth, not a committed JSON export. CI (`.github/workflows/deploy-recall.yml`) builds and syncs
it on every push to `main` via `bffless/deploy-proxy-rules@v1`, then attaches it to the `recall`
alias via `bffless/upload-artifact@v1`'s `proxy-rule-set-names` — import/attach is handled for you
if you're deploying through the workflow. To import it by hand into your own project:

```bash
npx bffless@^0.2.0 rules sync apps/recall/.bffless/proxy-rules/recall --project <owner>/<repo>
```

then attach the `recall` rule set to the alias serving the app (Admin → Aliases, or
`proxy-rule-set-names` on the upload step, as CI does).

Recall is also published to the CE app catalog (`apps/recall/bffless-app.json`) — installing it
from **Admin → Apps** on a CE ≥ 0.4.24 instance does the rule sync and alias attach for you, and
surfaces the manual steps below directly in the install flow.

## Manual setup (admin panel)

A rule sync alone isn't enough to make Recall work — three things need connecting by hand in the
BFFless admin panel before ingest, search, or chat will run:

1. **Connect Replicate** under **AI Services**. Every embedding call in this app — the index
   pipeline's `nateraw/bge-large-en-v1.5` call at ingest time, the same model at query time in
   `/api/search`, and the `rag-search` plugin's own query-embedding call inside `/api/chat` —
   goes through Replicate. It's also where WhisperX transcription runs (`/api/transcribe`). One
   token covers all three call sites; there's no separate transcription provider to wire up.
2. **Connect Anthropic** under **AI Services**. `/api/chat` runs `claude-haiku-4-5` in streaming
   mode for the RAG chat.
3. **Enable the AI Data Tools plugin** under project **Settings → AI → AI Plugins**. `/api/chat`'s
   `search_videos` tool is CE's `rag-search` plugin — the rule's `plugins: { mode: selected }`
   block only filters among plugins already enabled at the PROJECT level (CE's
   `buildToolsForProject` skips any plugin whose stored config has `enabled: false`), so listing
   `rag-search` in the rule alone isn't enough. **Symptom if this step is skipped**: chat runs
   completely toolless — the model prints raw `<function_calls>` XML as plain text in its reply
   and claims it found nothing, instead of actually calling `search_videos` (the same Replicate
   token from step 1 powers this tool's query embedding, no separate connection needed).
4. **Bucket CORS**. Video/audio/contact-sheet uploads go straight to your storage bucket via
   presigned PUT (`/api/uploads/{source,audio,sheet}/prepare`), so the bucket's CORS
   `Access-Control-Allow-Origin` list needs the exact origins the browser uploads from:
   `https://recall.j5s.dev` (production) and whatever origin serves the shared PR-preview alias
   (`recall-preview` — see `preview-recall.yml`'s header comment for why it's one fixed alias
   rather than a fresh one per PR). A local dev origin (`http://localhost:5173`) only needs this
   if you're testing real (non-mocked) uploads. Presigned/bucket storage is **required** — Recall
   has no fallback local-disk upload path. The same origin list also needs **GET** allowed: the
   admin detail page's "Generate frames" backfill button (`src/pages/AdminVideo.tsx`) captures a
   contact sheet from a *signed download* URL with `<video crossOrigin="anonymous">`, and canvas
   capture from a cross-origin `<video>` is only untainted when the actual GET response carries a
   matching `Access-Control-Allow-Origin` header — a bucket CORS entry that only allows PUT lets
   uploads through but leaves this backfill flow silently producing a tainted (unusable) canvas.

### Cross-origin isolation carve-out

If the BFFless project you're importing into applies `Cross-Origin-Opener-Policy` /
`Cross-Origin-Embedder-Policy` headers **project-wide** (e.g. Studio's ffmpeg-isolation response-
header rule, needed for `SharedArrayBuffer`), Recall's YouTube embeds (`SeekingPlayer`'s
`youtube.com/embed` iframes — search results, chat citations, the video detail page) will fail
with a **"COEP-framed resource needs COEP header"** console error and a blank/broken player: a
strict COEP policy blocks embedding any cross-origin frame that doesn't itself opt in with a
matching header, and `youtube.com` doesn't send one. Add a response-header rule scoped to
`apps/recall/**` (or whichever path this app serves under) that sets both headers to `unsafe-none`,
overriding the project-wide policy for just this app's pages. (This was hit and fixed live on
j5s.dev — Recall shares a project with Studio there.)

Nothing else needs a manual step: schemas (`recall_videos`, `recall_jobs`, `recall_uploads`,
`recall_conversations`, `recall_messages`) are created by the rule sync itself, and every admin
route already carries `auth_required { roles: ['admin'] }`.

## Language-swap recipe

The embedding model is pinned and must match at ingest time and query time, or every retrieval —
search results and the chat tool alike — is a numeric coincidence (two embedding spaces are not
comparable, similarity scores between them are meaningless). To swap `nateraw/bge-large-en-v1.5`
for a multilingual model (e.g. `beautyyuyanli/multilingual-e5-large`, which additionally wants
`passage:`/`query:` input prefixes to get its best retrieval quality — the e5 family was trained
with these), change `embeddingModel` in exactly three places:

1. **`rules/api/index/post/rule.yaml`** — the `embed` step's `model` field (the ingest-time
   embedding call, chunked transcript text → vectors, stored via `embed_store`).
2. **`rules/_custom/search-get/get/rule.yaml`** — the `embed` step's `model` field (the query-time
   embedding call that feeds `vector_search`; PR-feedback-7 moved this rule from
   `api/search/post/` to a `_custom` GET layout, see the Performance section below).
3. **`rules/api/chat/post/rule.yaml`** — the `rag-search` plugin's
   `plugins.options.rag-search.sources[0].embeddingModel` field (the tool's own query embedding,
   independent of the two rules above — it's inside the `ai_handler` step, not a standalone
   `replicate` step). **Two more keys travel with `embeddingModel` here, not just for e5** — the
   plugin's default embed request shape is `{text: "<query>"}`, but bge (the model this app ships
   pinned to) needs its input as `texts`, a JSON-stringified single-element array; without
   `embeddingInputField: texts` and `embeddingInputTemplate: '["{{query}}"]'` the tool call fails
   outright with "Failed to generate embedding". These describe the CURRENT model's own input
   contract, so update them alongside `embeddingModel` for whatever you swap to — an e5-family
   model changes the template to add its prefix (see below), a model that already expects a bare
   string might not need `embeddingInputField`/`embeddingInputTemplate` at all.

If you switch to an e5-family model, set the plugin's `embeddingInputTemplate` to
`'["query: {{query}}"]'` so query embeddings get the `query: ` prefix (index-time chunk text needs
the `passage: ` prefix too — add it in `rules/api/index/post/texts.fn.js`, alongside where the
`[t=Ns]` timestamp prefix is already prepended, since both share the same "text that actually gets
embedded" surface). **Known limitation**: the plugin does plain string substitution into
`embeddingInputTemplate`, not a real JSON-encode — a query containing a double-quote character
breaks the resulting JSON, and that one query's tool call fails gracefully (the assistant reports
no results, it doesn't crash) rather than being sanitized. A proper JSON-encode belongs in CE, not
a per-app workaround — tracked as a bffless/ce#651 follow-up.

**Then re-publish every video.** Changing the model doesn't retroactively re-embed anything —
existing rows keep their old-model vectors in `recall_videos.transcript`'s embedded chunks until
you unpublish + re-publish (Task 8's `/api/unpublish` then `/api/index`) each one. Mixed-model
libraries silently degrade: old videos never surface for new-model queries, because their vectors
live in a different space than the one being searched.

**A note on the `[t=Ns]` prefix**: chunk text carries an inline `[t=<sec>s] ` prefix ahead of the
transcript words (see `rules/api/index/post/texts.fn.js`). This is the interim carrier for each
chunk's start timestamp, until CE's `vector_search` handler and `rag-search` plugin return
`chunkMetadata` (start/end) directly on every hit — a CE patch proposed alongside this app (see
the plan's Task 1) but not yet merged/deployed everywhere. `shape.fn.js` (search) and the chat
rule's system prompt both prefer `chunkMetadata.start` when present and fall back to parsing the
prefix otherwise, so this app already works with or without that CE patch — but the prefix is
still the only carrier on an un-patched CE instance, so don't strip it from the embedded text
(only from what's shown to a person) if you're customizing the chunker.

## Performance

Every PUBLIC, read-only route sets an explicit `Cache-Control` so repeat page loads, back/forward
navigation, and identical repeat searches don't re-hit a pipeline (or, for search, an actual
Replicate embedding call) for data that hasn't meaningfully changed:

| Route | Cache-Control | Why this window |
| --- | --- | --- |
| `GET /api/search?q=` | `public, max-age=300` (5 min) | The expensive one — an embedding call + vector search per unique query. A just-published video won't appear in a *repeat of the exact same query* until the entry expires; a new query is an automatic cache miss and always fresh. |
| `GET /api/videos` (library grid) | `public, max-age=60` (1 min) | Cheap (one `data_query`), but hit on every home-page load — worth a short cache. |
| `GET /api/video?videoId=` (detail page) | `public, max-age=300` (5 min) on success; `no-store` on 404 | A 404 is never cached — a video that publishes moments after a failed lookup shouldn't stay "not found" for a shared cache's TTL. |
| `GET /api/uploads/sheets/*` (contact-sheet sprites) | `public, max-age=86400` (24h) | Every sheet path is genuinely immutable — `presigned_upload`'s default `keyStrategy: 'uuid'` mints a fresh random-uuid path on every upload, so regenerating a video's frames never overwrites an old path, it just points the record at a new one. A day-long cache of an old path is not a staleness risk. |
| `GET /api/chat?conversationId=` (resume) | none (no `response_handler`, so no header at all) | Personal-ish (a specific visitor's own conversation) — deliberately left uncached, verified there's no accidental `public` leaking through the framework's default response envelope. |
| Every admin route, `/api/recall/job` poll | `no-store` | Auth'd, must never land in a shared cache, and admin UIs need to see fresh state (a job poll caching its own "pending" would never see "done"). |

**Search moved from `POST` to `GET`** (`_custom/search-get/get/rule.yaml`, query param `q`) —
this wasn't optional: per RFC 9111, conforming HTTP caches only ever store `GET`/`HEAD` responses,
so a `Cache-Control` header on a `POST /api/search` response would have been silently ignored by
every real cache. The frontend's `searchApi.ts` switched from an RTK Query `mutation` to a `query`
endpoint to match — which also means the frontend gets its own in-memory cache/dedupe for the
lifetime of `keepUnusedDataFor`, layered on top of the HTTP-level cache.

**Nothing here needed a manual admin-panel step or fell outside rules-as-code** — every cache
policy above is expressed entirely in the rule set (`headers: {Cache-Control: ...}` on a
`response_handler` step, or `cacheability`/`cacheMaxAge` on `file_serve_handler`) and ships with a
normal `rules sync`/`rules push`.

**One caveat when re-syncing after this change**: converting search from POST to GET means the
OLD `POST /api/search` rule is now absent from the local rule set entirely — a plain
`bffless rules push` (no `--prune`) does **not** delete rules that are missing locally, it only
creates/updates what IS present, so the old POST rule stays live on the server (harmlessly
orphaned; the frontend never calls it anymore) until someone runs `bffless rules push --prune` (or
deletes it by hand in the admin panel).

## First-success checkpoint

You're wired up correctly once this whole loop works: sign in as an admin, upload a talk (or point
at an existing video/audio file), let it transcribe, paste the matching YouTube URL, click
**Publish** (publishing *is* indexing — see the app `CLAUDE.md`) and wait for it to finish. Then, on
the public site, search for a phrase you know is in the talk: a result card should show the video
with a timestamp chip, and clicking it should seek the inline player to that exact second. Finally,
ask the chat tab a question about the same talk — the answer should cite the moment it found as a
`[<title> @ mm:ss](...)` link, and clicking that citation should seek the player to a working deep
link into the video, the same way the search chip did.
