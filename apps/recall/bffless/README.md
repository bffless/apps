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
3. **Bucket CORS**. Video/audio/contact-sheet uploads go straight to your storage bucket via
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
2. **`rules/api/search/post/rule.yaml`** — the `embed` step's `model` field (the query-time
   embedding call that feeds `vector_search`).
3. **`rules/api/chat/post/rule.yaml`** — the `rag-search` plugin's
   `plugins.options.rag-search.sources[0].embeddingModel` field (the tool's own query embedding,
   independent of the two rules above — it's inside the `ai_handler` step, not a standalone
   `replicate` step).

If you switch to an e5-family model, also set the plugin's `embeddingInputField` /
`embeddingInputTemplate` options so query embeddings get the `query: ` prefix (index-time chunk
text needs the `passage: ` prefix too — add it in `rules/api/index/post/texts.fn.js`, alongside
where the `[t=Ns]` timestamp prefix is already prepended, since both share the same "text that
actually gets embedded" surface).

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

## First-success checkpoint

You're wired up correctly once this whole loop works: sign in as an admin, upload a talk (or point
at an existing video/audio file), let it transcribe, paste the matching YouTube URL, click
**Publish** (publishing *is* indexing — see the app `CLAUDE.md`) and wait for it to finish. Then, on
the public site, search for a phrase you know is in the talk: a result card should show the video
with a timestamp chip, and clicking it should seek the inline player to that exact second. Finally,
ask the chat tab a question about the same talk — the answer should cite the moment it found as a
`[<title> @ mm:ss](...)` link, and clicking that citation should seek the player to a working deep
link into the video, the same way the search chip did.
