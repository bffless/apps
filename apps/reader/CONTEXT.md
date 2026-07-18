# Reader — Domain Context

> **Status:** design in progress (grilling session). **Working name "Reader" — provisional**, rename is cheap before real code lands.

A Google Reader–style RSS/Atom feed reader, shipped as a give-away app in the `bffless-apps`
monorepo. Personal, single-user per deploy. Background auto-refresh via **two new Community Edition
(CE) capabilities** — a feed-ingest handler and a scheduled-pipeline (cron) primitive.

## Ubiquitous language

- **Feed / Subscription** — a followed RSS/Atom source (URL + title + folder). One row per feed.
- **Item / Entry** — a single post from a feed. One row per item, deduped by GUID.
- **GUID** — the item's stable id (RSS `<guid>` / Atom `<id>`, falling back to `<link>`). The dedup key on upsert.
- **Folder** — a user grouping of feeds (Reader's folders/tags-on-feed). A feed belongs to one folder.
- **River** — the unified stream of unread items across all feeds; the default reading view.
- **Star** — a "keep forever" flag on an item. Prune-exempting. This *is* the save feature.
- **Read / Unread** — per-item state; drives the unread counts and auto-mark-on-scroll.
- **`xml_feed_parse`** (new CE handler, **generic**) — fetch one or more feed URLs concurrently and parse RSS 2.0 / Atom / RDF into a normalized, format-neutral entry list. Knows data formats, not apps. Reusable by e.g. a future podcast app (podcast feeds are RSS; audio lives in `enclosures[]`).
- **`data_upsert_many`** (new CE handler, **generic**) — insert an array of records into a target schema, skipping any whose dedup-key value already exists. Reusable for any sync/import. The item-level loop lives inside it — no executor `foreach` needed.
- **Normalized entry** — `xml_feed_parse` output shape: `{ source, guid, title, link, author, publishedAt, content, summary, enclosures[], extensions{} }`. `extensions{}` passes through namespaced tags (e.g. `itunes:*`) so consumers read what they need without the parser knowing about them.
- **Schedule** (`pipeline_schedules`, new CE primitive) — "run pipeline X every N minutes," per project. Modeled on `repos/ce/apps/backend/src/retention/`.
- **Refresh** — one run of the ingest pipeline (manual, or fired by a Schedule).
- **Auto-discovery** — paste a site URL (`someblog.com`) → resolve its feed URL.
- **OPML** — the standard subscription-list XML; import (bring old feeds in) and export.

## Architecture

- **Frontend:** Vite SPA (same shape as `apps/studio`, `apps/handoff`). No server.
- **App backend:** a BFFless proxy rule set + pipelines + Data-Table schemas (imported/attached per the repo convention).
- **Three new CE enhancements** — all **generic/reusable**, none reader-specific (tracked in `repos/ce`, separate PRs — "enhancing CE is first-class"):
  1. **`xml_feed_parse` handler** — the reusable XML/feed consumer (solves the "no XML parser" blocker). Backed by a pure, unit-tested `FeedParserService` (`fast-xml-parser`).
  2. **`data_upsert_many` handler** — generic array→schema insert-with-dedup (solves the "no array fan-out" blocker without a generic executor loop).
  3. **`pipeline_schedules` cron primitive** — general "run pipeline X every N min per project." Cheap: `@nestjs/schedule` is already wired; `src/retention/` is a working template.
- **The reader is a *composition*, not custom backend code:** `data_query(feeds) → xml_feed_parse(urls) → data_upsert_many(items, dedupKey: guid)`. A podcast app is the same shape with different schemas + field mapping. App-specificity lives in pipeline **config**, not CE code.

## Data model (per-item, deduped by GUID)

- **feeds** — `id`, `url`, `siteUrl`, `title`, `folder` (nullable string; null = uncategorized), `iconUrl` (nullable), `lastFetchedAt`, `lastError` (nullable), `addedAt`.
- **items** — `id`, `guid` (dedup key), `feedId`, `title`, `link`, `author`, `publishedAt`, `summary`, `content`, `read` (boolean, default false), `starred` (boolean, default false), `archived` (boolean, default false), `fetchedAt` (**`number`, epoch-ms** — ingest stamps `Date.now()`; the retention prune filters it with a numeric `<`, so it must be numeric, not an ISO string — #119).
- **`data_upsert_many` mapping** (normalized entry → `items`, `dedupKey: guid`): `guid ← guid||link||hash` · `title, link, author, publishedAt, summary, content ← entry.*` · `feedId ← current feed` · `fetchedAt ←` a `stamp` step's `Date.now()` (epoch-ms) · `read/starred ←` literal `false` (so read+unstarred items are prune-eligible; the star/read endpoints then flip them per user action).
- **Content is stored raw; sanitized at render** (client-side DOMPurify) — keeps the generic `xml_feed_parse` policy-free (D7) and lets the sanitizer tighten without re-fetching. Both `summary` (list preview) and `content` (reading pane) stored; truncated feeds → `content` falls back to summary.
- **Folders** = a nullable `folder` string on the feed (Reader-style, one folder per feed). No folders table in v1.
- **Retention:** starred → forever; unread → forever; read + unstarred + older than **30 days** → pruned (a natural second consumer of the cron).

## Decisions log

- **D1** — Personal reader, **single-user per deploy**. No accounts/follow-graph. Social deferred to v2. *(Give-away app model; keeps focus on the novel infra.)*
- **D2** — v1 = the Reader **core loop** (add-feed + auto-discovery, folders, river + per-feed/folder views, read/unread + auto-mark-on-scroll + mark-all-read, star, keyboard nav, oldest-first, OPML in/out, refresh). Deferred to v2: social, full-text extraction, search, per-item tags, recommendations.
- **D3** — **Background auto-refresh is v1** (chose B over browser-parse/manual). Requires the CE feed-parse work + cron.
- **D4** — **Per-item storage**, deduped by GUID (not per-feed snapshot). Fan-out lives inside the bespoke `feed_ingest` handler; no generic-executor surgery.
- **D5** — **Star = a prune-exempting flag on the item** (not a separate "Saved" collection).
- **D6** — **Retention 30 days** (starred & unread exempt).
- **D7** — **No bespoke reader handler.** Ingest is a composition of **two generic CE handlers** — `xml_feed_parse` (fetch+parse, concurrent) and `data_upsert_many` (array insert + dedup) — plus existing `data_query`. Both handlers are domain-agnostic and reusable (e.g. a podcast app). App-specificity (schemas, field mapping, dedup key) is pipeline **config**, not code. *Guardrail: if `xml_feed_parse` ever grows an app-mode flag, the boundary is leaking — put it in the normalized output as data instead.*
- **D8** — **Items are immutable once stored** (dedup skips known keys; feed edits aren't re-synced — known v1 limitation). **Dedup key = `guid || link || hash(source + title + publishedAt)`.** Conditional GET (etag/lastModified) **deferred** to keep the batch-parse interface clean.
- **D13** — **Build sequencing & modes: CE first (in-the-loop), then the app (Sandcastle).** The three generic CE primitives are built interactively in `repos/ce` and must land before Rivulet, which is built via Sandcastle (async, `ready-for-agent` issue) and depends on them. PRD packaging follows this split.
- **D12** — **Auto-discovery + OPML are browser-side** (`DOMParser`). Cross-origin fetches (discovery) route through the existing generic `http_request` proxy; feed inserts (add-feed **and** OPML import) reuse `data_upsert_many` (dedup by `url`); OPML export is generated client-side. **No new CE handlers.** SSRF hardening on `http_request` deferred to v2 — acceptable for v1 given the private, single-user-behind-auth posture.
- **D11** — **Auth = real SuperTokens via reverse-proxy**, *not* the `_bffless/auth` relay (`/_bffless/*` is reserved for custom domains). A reverse-proxy rule maps `/api/auth/* → backend /api/auth` (`localhost:3000/api/auth` in dev). `/api/*` guarded by SuperTokens `SessionAuthGuard`. Site private (login required), **no public surface in v1** (public shared/starred pages ride with the social v2). Cron refresh runs as **system context** (no session, `onboarding-executor` pattern); data is project-scoped (single user), so session + system share schemas.
- **D10** — **Schemas finalized** (see Data model): content **stored raw, sanitized at render** (DOMPurify) — not at ingest, keeping `xml_feed_parse` policy-free; **both `summary` and `content`** stored; **folder = nullable string** on the feed, no folders table.
- **D9** — **Cron primitive stores cron expressions** (`cronExpression` + optional IANA `timezone`, default UTC); the **UI presents interval/time presets** that compile to cron (raw-cron field is a later add). `nextRunAt` computed via `cron-parser`; master poller is `@Cron(EVERY_MINUTE)`. **Atomic conditional claim** (`UPDATE … SET executionStartedAt WHERE executionStartedAt IS NULL`) — built now for replica-safety, not the in-process boolean. Table `pipeline_schedules` (projectId, targetProxyRuleId, cronExpression, timezone, enabled, lastRunAt, nextRunAt, executionStartedAt, lastError), modeled on `retention-rules.schema.ts`.
- **D14** — **Manual per-item Delete (hard) + Archive (hidden, prune-exempt, insert-only-dedup keeps it from resurrecting); no auto-reconcile** — RSS windowing would destroy kept history. `archived` is a flag like `starred`: `GET /api/items` hides archived rows by default (opt back in with `?includeArchived=true`), `GET /api/counts` and `POST /api/prune` always treat archived as excluded/exempt. `POST /api/items/delete` hard-removes the row (`data_delete` by `guid`) for cleaning up dead/source-deleted posts; because ingest is insert-only-dedup-by-guid, a still-in-feed item can re-insert on the next refresh — deletion isn't a permanent block, archive is the durable "make it go away" action.

## Deferred to v2+

Social/sharing + public shared-or-starred pages (Q1) · full-text extraction of truncated feeds · cross-item search · per-item tags (distinct from feed folders) · recommendations/explore · conditional GET (etag/lastModified) on refresh · per-feed refresh cadence (vs one shared cadence) · re-syncing edited items (D8: items immutable in v1) · raw cron-expression field in the schedule UI (D9) · SSRF allow/block-list on `http_request` if the app ever goes multi-user/public (D12) · general CE `foreach`/subpipeline loop primitive (only if a second use case demands it).

## Status

Grilling complete — full design tree walked (D1–D13). Name settled: **Rivulet**.

**CE primitives — DONE** (built in-the-loop in `repos/ce`): bffless/ce **#406** `xml_feed_parse`, **#407** `data_upsert_many`, **#408** `pipeline_schedules`.

**App — sliced for Sandcastle.** PRD `bffless/apps#105`, broken into 9 `ready-for-agent` tracer-bullet issues:
- **#111** scaffold + auth spine · **#112** add feed → read items (core tracer) · **#113** auto-discovery · **#114** river + read/unread · **#115** star/save · **#116** folders · **#117** OPML import/export · **#118** keyboard nav + oldest-first · **#119** background refresh + retention.
- Dependency spine: everything blocks on **#111**, then most on **#112**; **#118**→#114; **#119**→#112/#114/#115.

Next: Sandcastle works the slices (#111 first) and **owns live wiring** — proxy-rule-set import/attach + `/api/auth` + the two schedules — via its BFFless deploy API key (verify key scope). Live wiring is no longer a manual post-merge step.

**#119 wired (background refresh + retention).** Both `pipeline_schedules` are live on the reader project: refresh `*/15 * * * *` → `POST /api/refresh`, prune `17 3 * * *` → `POST /api/prune`, both UTC and system-context. Two gotchas surfaced and were resolved this slice: (1) `now()` returns an **ISO string**, but the retention prune needs a numeric range compare — so ingest now stamps `fetchedAt = Date.now()` (epoch-ms) and the `reader_items` schema types it `number`; (2) freshly-ingested items must carry `read=false`/`starred=false` (not null) so a read-but-never-starred item is prune-eligible via `data_delete`'s `starred != true` filter. `data_delete` delete-by-query (read=true AND starred!=true AND fetchedAt<cutoff) expresses the whole retention rule in one step — no executor loop needed (bffless/ce#412 widened its operators to include `<`). (3) The CE scheduler fires a schedule as a **userless system run** and still runs the target's validators, so `auth_required` (which needs `context.user`; `allowApiKey` only helps a *keyed HTTP request*) rejected the run with "Authentication required." Fix: the two schedule-fired pipelines drop `auth_required` — the reader alias is **private** (edge-gated), so anonymous HTTP is bounced to login before reaching the pipeline, while the scheduler bypasses that edge. So D11's "cron runs as system context" holds via edge privacy, not a per-rule validator.

**Schedule API — exact endpoint (don't guess the URL).** The `pipeline_schedules` CRUD lives on its own controller, **not** nested under projects:
- create: `POST /api/pipeline-schedules/projects/:projectId/schedules`
- list: `GET /api/pipeline-schedules/projects/:projectId/schedules`
- by id: `GET|PUT|DELETE /api/pipeline-schedules/schedules/:id`

Do **not** call `/api/projects/:projectId/pipeline-schedules` — that path doesn't exist and collides with the projects `:owner/:name` catch-all, returning a misleading `400 "Project not found"` (same trap for proxy-rule-sets, whose real path is `GET /api/proxy-rule-sets/project/:projectId`). This was gated on **bffless/ce#411** (schedules service honoring api-key project scope) and **bffless/ce#412** (`data_delete` range operators for the prune) — both have since landed, and #119 is wired per the note above. See the wiring/blocker thread on `bffless/apps#119`.
