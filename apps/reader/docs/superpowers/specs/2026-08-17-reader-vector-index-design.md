# Rivulet: vector index, semantic search and chat over feeds

**Date:** 2026-08-17 · **Status:** approved design (grilling session), not yet implemented
**App:** `apps/reader` (Rivulet) · **Tracking:** epic bffless/apps#345 · **CE work:** bffless/ce#680 #681 #682 #683

## Problem

Rivulet stores every feed item as a per-user row in `reader_items` (D15, copy-per-user), but the
only way to find something again is to scroll. Users want to (a) search their feeds semantically
("that post about pgvector HNSW tuning") and (b) chat over them ("what did my Rust feeds say about
async drop this month?"), with citations back to the item. CE already ships the vector primitives
(`embed_store`, `vector_search`, the `rag-search` AI plugin, pgvector) and Recall proved the
Replicate-embed → pgvector → `ai_handler` shape end to end.

Indexing costs money (Replicate embeddings) and needs an AI token the installer must add, so the
user has to be in control of **what** gets indexed: everything by default, a whole feed, a single
item, or nothing — and be able to take an item back out.

## Goals

- User-controllable index membership at three levels: user default, per feed, per item.
- Semantic search over the user's indexed items, scoped to all / one feed / one folder.
- Streaming chat over the same index with citations that link to items, conversation history persisted.
- Zero regression for users who never turn indexing on: no tokens required, no new cron cost, no UI noise.
- Multi-user safe: a user only ever searches / chats over their own rows.

## Non-goals (deferred)

- Full-text / keyword search over un-indexed items (needs a different CE primitive; `data_query` has no FTS).
- A separate retention window for indexed items (v1: indexed = kept, see D21).
- Configurable embedding provider/model per install (one model, one place to change it).
- Cross-user / shared indexes, social features.
- Re-embedding on model version change (recovery path exists: remove all → index existing).

---

## Domain model

New / changed terms (also added to `apps/reader/CONTEXT.md`):

- **Index** — the set of a user's items that are embedded and therefore searchable and chattable.
  *In the index* is a "keep and make searchable" flag on an item, a sibling of *Star*: indexed items
  are prune-exempt.
- **Index preference** — the three-layer rule that decides whether an item *should* be indexed:
  1. **Item override** `reader_items.indexed: true | false | null` — set only by an explicit user
     action ("Index this" / "Remove from index"). **Sticky**: wins over feed and user settings and
     survives later feed/user flips.
  2. **Feed mode** `reader_feeds.indexMode: 'inherit' | 'always' | 'never'` (default `inherit`).
  3. **User default** `reader_settings.indexByDefault: boolean` (default `false`, opt-in).
  Effective at ingest and on flips: `item.indexed ?? (feed.indexMode !== 'inherit' ? feed.indexMode === 'always' : user.indexByDefault)`.
- **Index state** `reader_items.indexState` — what has *actually* happened:
  `null/absent` (never considered) · `pending` (queued) · `indexing` (claimed by a drain run) ·
  `indexed` · `skipped` (deliberately not indexed / removed) · `error` (last attempt failed,
  `indexError` holds the message, retried). Plus `indexedAt` (epoch ms).
- **Drain** — one run of the index queue pipeline: claim ≤25 `pending` items, embed, store, mark.
- **Chunk** — one embedded slice of an item's text; an item has 1–6 chunks.
- **Search** — a semantic query over the index; results are items (best chunk wins).
- **Chat** — an `ai_handler` conversation whose retrieval tool is a `vector_search` over the index.

Because rows are copy-per-user (D15), *every* index control acts on that user's copy only. Two
subscribers to the same feed index it independently; nothing crosses users.

---

## Decisions

Numbered to continue Rivulet's log (D1–D15 in `apps/reader/CONTEXT.md`).

- **D16 — Three-layer index preference; sticky item override; feed flips act on existing items.**
  A per-item "remove" sets `indexed=false` and stays false even if the feed later becomes `always`.
  Flipping a feed to `always` back-indexes its existing items (that lack an override); flipping to
  `never` purges existing embeddings for its items (except items pinned `indexed=true`).
- **D17 — Embeddings via Replicate `beautyyuyanli/multilingual-e5-large`**, version pinned to
  `a06276a89f1a902d5fc225a9ca32b6e8e6292b7f3b136518878da97c458e2bad`, 1024-dim, `normalize_embeddings: true`.
  Chosen over `nateraw/bge-large-en-v1.5` (Recall): ~220× the run count (75.9M vs 340K → far more
  likely warm), same dimension and the *same* input contract (`texts` = JSON-string array,
  `batch_size`), multilingual (RSS is often non-English), and CE's `rag-search` plugin already
  strips e5's `passage: ` / `query: ` prefixes. **Prefix convention:** indexed text is
  `passage: …`, queries are `query: …`. The model id + version live in exactly one place per rule
  set (a YAML anchor / shared constant) so swapping is one edit.
- **D18 — Chunked 1:N embeddings.** Text = `title` + HTML-stripped `content || summary`; chunks of
  ~1500 chars with ~200 overlap, `title` prepended to every chunk, **cap 6 chunks/item** (worst case
  6 embeddings per item, predictable spend). `chunkMetadata` = `{ chunkIndex, title, link, feedId,
  publishedAt }` so chat citations need no second lookup. Strip + chunk + prefix live in **one**
  `chunk.fn.js` shared by index and search paths so they cannot drift.
- **D19 — Index queue + drain schedule (not inline in refresh).** Every path that wants indexing
  writes `indexState='pending'`; every path that wants removal writes `'skipped'` and purges inline.
  One pipeline `POST /api/index/drain` on a `pipeline_schedule` every 2 min: claim ≤25 pending →
  chunk → one Replicate batch call → `embed_store` (records mode) → mark `indexed` / `error`.
  Refresh never waits on Replicate; retries and cold starts are absorbed by the queue; ≤2 min to
  searchable is acceptable for a reader.
- **D20 — `reader_settings` schema, one row per user, `indexByDefault=false`.** Read unscoped by
  the userless refresh (like feeds), and via `GET/PUT /api/settings`. Absent row ⇒ built-in default.
  Opt-in because indexing spends money and needs a token; the feed/item controls work regardless.
- **D21 — Indexed items are prune-exempt.** Retention filter becomes
  `read=true AND starred!=true AND archived!=true AND indexState!='indexed' AND fetchedAt<cutoff`
  (one more `ne` clause, no CE change). Removing from the index makes the item prune-eligible again.
- **D22 — Search is semantic-only over indexed items**, scoped `all | feed:<id> | folder:<name>`,
  rendered as a virtual "Search results" view in the existing item list / reading pane. Un-indexed
  items are simply not searchable; empty states say so and offer "index this feed". Requires the CE
  `vector_search` filter (userId; feedId `eq`/`in`).
- **D23 — Chat = `ai_handler` chat mode + `rag-search` plugin** (Recall's pattern): streaming,
  `claude-haiku-4-5` / anthropic, tool `search_feeds` = plugin `vector_search` source over
  `reader_items.content`, filtered by the caller's userId (`filterSource: 'user_id'`) and an
  optional scope passed as tool input, conversations persisted to `reader_conversations` /
  `reader_messages`. Citations `[title](link)` from `chunkMetadata`.
- **D24 — `embed_delete` CE handler** (`recordIds[]` and `where` modes) for removal without deleting
  the row; purge runs **inline** in the endpoint (local DB, fast). Only *creation* goes through the
  drain queue.
- **D25 — Client-kicked drain + claim state.** `POST /api/items/index` marks pending and responds;
  the client immediately `POST /api/index/drain`s so the item the user is looking at is searchable
  in seconds. Drain claims by `data_query(pending, limit 25)` → `data_update(filters: id in [...])
  → 'indexing'` (two steps — `data_update` filter mode has no `limit`, verified; no CE change).
  A stale-claim sweep (`indexing` older than 10 min → `pending`) runs at the top of each drain.
  Item UI states: *not indexed · queued · indexing · indexed · failed (retry)*.
- **D26 — Tokens optional, degrade visibly.** Replicate + Anthropic are listed as *optional*
  external connections ("needed for Search & Chat"). Pipelines can't test token presence, so the
  drain writes provider errors to `indexError`; the settings page shows an **Index health** panel
  (counts by `indexState` via `db_aggregate` + latest `indexError` + hint "Add a Replicate token
  under Project → AI settings"). Search/Chat entry points are always visible with explanatory empty
  states.
- **D27 — User default is forward-looking.** Turning it on affects new items only, plus an explicit
  **"Index my existing items (N)"** button (enqueues everything not indexed and without an
  override; count shown before). Turning it off stops future indexing but doesn't purge; a separate
  **"Remove all from index"** (confirm) does.
- **D28 — Pin the embedding version at all three embed sites.** Drain and search use the
  `replicate` step's `version`; chat uses the new plugin `embeddingModelVersion` (CE #2 below).
  Drift risk if ever unpinned: stored vectors from one version, queries from another; recovery =
  remove all → index existing.

---

## Data model changes

**`reader_settings`** (new) — `userId` (string), `scopedKey` (= userId, dedup), `indexByDefault`
(boolean), `updatedAt` (number).

**`reader_feeds`** (+1) — `indexMode` (string: `inherit|always|never`; absent = inherit).

**`reader_items`** (+5) — `indexed` (boolean, nullable override), `indexState` (string),
`indexedAt` (number), `indexError` (string), `indexAttempts` (number; give up → `error` stays after 5).
Embeddings live in CE's `pipeline_data_embeddings` keyed `(schemaId=reader_items, fieldName='content')`.

**`reader_conversations`**, **`reader_messages`** (new) — same shape as Recall's, plus `userId`.

Refresh `map` gains `indexState: steps.item.indexState` (computed in `enrich.fn.js` from the feed
row's `indexMode` and the subscriber's `reader_settings` row → `'pending'` or `null`) and
`indexed: null`.

---

## API surface (proxy rule set `reader`)

| Path | Method | Auth | Pipeline |
| --- | --- | --- | --- |
| `/api/settings` | GET | user | `data_query(reader_settings, userId)` → row or defaults |
| `/api/settings` | PUT | user | `data_upsert_many(dedup scopedKey)` `{ indexByDefault }` |
| `/api/feeds/index-mode` | POST | user | `{ feedId, indexMode }` → `data_update` feed; `always` → `data_update` items of feed w/o override → `pending`; `never` → `embed_delete where {userId, feedId, indexState:'indexed', indexed ne true}` + `data_update` → `skipped` |
| `/api/items/index` | POST | user | `{ guid }` → `data_update` `{ indexed:true, indexState:'pending' }` |
| `/api/items/unindex` | POST | user | `{ guid }` → `embed_delete recordIds:[id]` + `data_update` `{ indexed:false, indexState:'skipped' }` |
| `/api/index/drain` | POST | none (edge-gated + schedule) | sweep stale → claim 25 → load → `chunk.fn.js` → `replicate` (pinned e5, batch) → `zip.fn.js` → `embed_store` (records) → mark `indexed` / `error` → respond counts |
| `/api/index/backfill` | POST | user | enqueue all of the user's items with `indexState != indexed` and `indexed ne false` → `pending`; responds count |
| `/api/index/purge` | POST | user | `embed_delete where {userId}` + `data_update` → `{ indexState:'skipped', indexed:null }` — the reset button: clears item overrides too |
| `/api/index/health` | GET | user | `db_aggregate` counts by `indexState` for userId + latest `indexError` |
| `/api/search` | GET | user | `?q&scope&limit` → `scope.fn.js` (folder → feedIds via `data_query(reader_feeds)`) → `replicate` (`["query: <q>"]`) → `vector_search` (filters userId, feedId) → `group.fn.js` (best chunk per item, snippet) → items |
| `/api/chat` | POST | user | `ai_handler` chat + `rag-search` (`search_feeds`, filters userId + optional scope tool input), persist to `reader_conversations/messages` |
| `/api/conversations` | GET/DELETE | user | list / delete the caller's conversations |
| `/api/prune` | POST | (existing) | + `indexState ne indexed` clause |
| `/api/refresh` | POST | (existing) | map + `indexState`, `indexed` |

Schedules: existing refresh (15 min) + prune (nightly) + **new** drain `*/2 * * * *` (UTC, system
context, no `auth_required` — same edge-privacy argument as refresh/prune).

The drain is safe to overlap (cron + client kick) because of the claim step; `embed_store` is
delete-then-store so a rare double-embed is idempotent (only costs a duplicate Replicate call).

---

## UI

- **Settings page** (new route `/settings`): *Index new items by default* toggle · **Index health**
  panel (counts + last error + token hint) · *Index my existing items (N)* · *Remove all from index*
  (confirm) · short cost/token explainer.
- **Feed section** (sidebar feed context menu + feed header): *Index: inherit / always / never*
  segmented control; `always` shows a "will index N existing items" note.
- **Item** (reading pane toolbar + list row hover, next to star/archive): *Index* / *Remove from
  index* toggle with state badge (queued / indexing / indexed / failed → retry). Keyboard: `i`.
- **Search**: header search box (`/` focuses); scope chip defaults to the current view (river → all,
  feed → that feed, folder → that folder); results render in the item list as a virtual view with
  similarity-ordered items and a snippet; empty state explains indexing + offers "Index this feed".
- **Chat**: a "Chat" pane/route with conversation list, streaming responses, same scope chip, item
  citations as links that open the item in the reading pane.

Sanitisation: chunk text is derived from raw stored HTML by a tag-strip + entity-decode in the
function sandbox (no DOM); it is only ever fed to the embedder / model, never rendered.

---

## CE work (bffless/ce) — all required (#680, #681, #682, #683)

1. **`vector_search` handler: `filters` on the joined record** — reuse `filter-where.util`
   (`eq/ne/in/gt/lt…`) against `pipeline_data.data`; same `filters` / `filterLogic` shape as
   `data_query`. Without it a multi-user schema leaks every user's rows.
2. **`rag-search` plugin, vector source: `filters` + `filterSource` parity with the `data_query`
   source** (`user_id` | `tool_input`), **and `embeddingModelVersion`** (skip `resolveLatestVersion`
   when set; UI field "Embedding Model Version" beside "Embedding Model").
3. **`embed_store`: `records` array mode** — `records: expr` → `[{ recordId, chunks | embedding, metadata? }]`,
   per-record delete-then-store, output `{ stored, records, errors[] }`. Today one record per step
   and there is no loop primitive.
4. **`embed_delete` handler (new)** — `{ schemaId, fieldName?, recordIds: expr }` or `{ …, filters }`;
   deletes from `pipeline_data_embeddings` without touching the row. Today embeddings only go away
   on row delete or via `embed_store`'s delete-then-store.

Nice-to-have, non-blocking: bulk `data_update` `limit`.

---

## App slices (bffless/apps, `ready-for-agent`, tracer-bullet order)

- **S1 — schemas + settings + state plumbing.** `reader_settings`, `indexMode`, item index fields;
  refresh map + prune clause; `GET/PUT /api/settings`; settings page with the default toggle. No
  embedding yet.
- **S2 — drain + item/feed controls.** `/api/index/drain` + schedule, `chunk.fn.js`, item
  index/unindex, feed index-mode (+ back-index / purge), client-kicked drain, state badges,
  `/api/index/health` panel. *Depends on CE #3, #4.*
- **S3 — search.** `/api/search` + scope + results view. *Depends on CE #1.*
- **S4 — chat.** `/api/chat`, conversations, chat pane, citations. *Depends on CE #2.*
- **S5 — bulk actions.** backfill / purge endpoints + buttons, docs (`bffless/README.md`,
  `bffless-app.json` optional connections), CONTEXT.md finalisation.

S1 → S2 → (S3 ∥ S4) → S5. CE items ship first (in-the-loop in `repos/ce`, per D13's precedent).

## Risks / open items

- Replicate cold start on the drain: absorbed by the queue; item shows *indexing* meanwhile.
- Cost surprise: mitigated by opt-in default, 6-chunk cap, explicit counts before bulk actions.
- `vector_search` returns at most 200 chars per string field (SQL-side trim) — fine, we re-load
  nothing; the item list already has the row client-side, results carry `id` + `similarity` + snippet.
- HTML stripping in a regex sandbox is imperfect on pathological markup; acceptable for embeddings.
- e5's 512-token window: 1500 chars ≈ 350–400 tokens with the title prefix; safe.
