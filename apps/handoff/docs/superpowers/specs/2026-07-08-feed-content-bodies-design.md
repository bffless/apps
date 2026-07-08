# Feed content bodies — CE pipeline composition — design

**Date:** 2026-07-08
**Status:** Approved (brainstorm), pending spec review
**Spans:** CE (`repos/ce/`) — new pipeline primitives · Handoff app (`repos/apps/apps/handoff/`) — feed consumer

## Problem

Handoff's RSS [[Feed]] renders each [[File]] as a [[Feed Item]] with a `<title>`, an
`<enclosure>` (the media URL + mime + length), and a `<description>` that is only a
name/size line (or an inline `<img>` for images). For a markdown post (`post.md`) the
reader shows a title and an **empty body** — the `<enclosure type="text/markdown">` is an
*attachment reference*, not content, and virtually no reader fetches and renders it.

We want the **post body itself inline in the feed** — a real `<content:encoded>` HTML body
readers display — for markdown now, and **for [[Site]] HTML next** (an explicit near-term
requirement that shapes this design).

## Decisions (from brainstorm)

- **Storage is the single source of truth. Rendered HTML is a *cached response*, never a
  durable second copy.** We do **not** materialize rendered bodies into the `handoff_nodes`
  DB record. Duplicating markdown — and later whole Site HTML documents — into `pipeline_data`
  rows means two durable homes that drift and must be synced; it doubles storage and fights
  Handoff's structural-storage model. The feed reads content **on demand from the bucket** at
  build time.
- **Performance comes from caching the feed *response*, not from pre-storing content.** RSS
  readers poll; a feed's bytes only change when a folder's files change. An HTTP cache rule on
  `/feed/*` serves polls from cache, so the expensive path (read blobs → render) runs only on a
  **cache miss** — amortized to ~once per TTL, not once per poll. No DB duplication.
- **Content is resolved by pipeline composition, not custom Node or sandbox JS.** A generic CE
  **loop primitive** iterates the surfaced items and, **in-process**, calls a **child pipeline**
  that fetches + renders one item's content. The child is an independently callable, testable
  unit; the loop is reusable platform control flow. (Chosen over a single purpose-built Node
  handler that buried the iteration — that was not pluggable.)
- **In-process invocation** (not HTTP subrequest). The loop runs the child as a direct call in
  the same request/auth context — no network hop, ~50 fast calls on a cache miss. (Subrequest,
  with its per-item HTTP cache, was considered and rejected for v1 as extra network + internal-
  auth surface; the whole-feed cache already makes the loop rare.)
- **Every pipeline is callable by default — no "callable" flag.** A pipeline does not need to
  know it is running as a child. See "Response decoupling" — CE, not the pipeline author, adapts
  behavior based on how the pipeline was entered. We add an opt-out only if a concrete reason
  appears.
- **`<content:encoded>` is purely additive; failures degrade to today's feed.** A child that
  fails (missing blob, render error, timeout) simply yields no body for that item — it keeps its
  current `<title>` + `<enclosure>` + name/size rendering. One bad post never breaks the other 49
  or the feed's `200`.
- **Type-polymorphic child.** The same child pipeline branches on the item: `text/markdown` →
  render markdown; **Site → sanitize entry HTML (next iteration).** Site support is a second
  branch on one mechanism, not a bolt-on.

## Key findings (verified)

- **`function_handler` cannot read blob bytes.** It runs in a sandboxed VM with no `fetch`,
  `Buffer`, `require`, or `process` (bffless-pipelines skill). The feed pipeline builds items
  purely from `handoff_nodes` DB records; content bytes live in the bucket and are only ever
  *streamed out* (`file_serve_handler`) or handed off as presigned URLs. Reading content into the
  pipeline therefore **requires a new CE data handler** — it is not achievable in-app.
- **The feed logic is triplicated and must stay in sync:** `src/lib/feed.ts` (reference impl),
  the port embedded in the `/feed/*` pipeline in `bffless/handoff.proxy-rules.json`, and the
  **live** BFFless rules. `feedRule.test.ts` asserts reference↔pipeline parity.
- **The feed surfaces only the 50 newest leaves** (`FEED_ITEM_LIMIT`), so the loop bounds at ≤50
  child calls per cache miss, and pre-existing (un-inlined) posts naturally age out of the window
  as new (inlined) uploads arrive — **no backfill/migration is required** (see below).
- **Uploads finalize one file at a time** via `presigned_upload` → `register_upload`
  (direct-to-bucket, verbatim structural keys). There is no batch-upload path, so steady state
  never needs a loop — only the feed read path does.
- **Media/content URLs** already distinguish public (`/api/uploads/content/…`, tokenless) from
  private (`/r/<id>/<slug>?token=`). The content resolver reads from the **storage key** on the
  record, not these URLs.

## Architecture

### Overview

```
PARENT   /feed/<path>.xml     [HTTP cache rule, short TTL]
  1. select surfaced items            (existing fn_handler: access-filter + newest-50)
  2. foreach item → CALL child        (NEW loop primitive, in-process, per-item isolation)
  3. assemble RSS + <content:encoded> (existing fn_handler, additive)

CHILD    resolve-content              input: { id, storageKey, mime, type }
  a. read_object_text                 (NEW CE handler: bucket object → text)
  b. markdown_render   [if mime = text/markdown]   (NEW CE handler: md → HTML)
     sanitize_html     [always / site branch]      (NEW CE handler: HTML → safe HTML)
  c. response { id, html }
```

The child ends in a normal `response_handler`. Because the loop calls it **in-process**, CE
returns that response *object* to the loop instead of flushing it to a socket (see next).

### CE change 1 — Response decoupling (produce vs transmit)

Today a pipeline's terminal step *sends* the HTTP response (writes the Express `res`). Split the
two welded jobs:

- **`response_handler` produces a result object** `{ status, headers, body }` — it no longer
  writes the socket.
- **The runner transmits it.** The **HTTP entrypoint** adapter flushes the object to the socket
  (byte-identical to today). The **in-process `call` runner** hands the object back to the caller
  (the loop) as the step's output.

Consequences:

- A pipeline is **dual-mode by construction** — one pipeline, works over HTTP or as a child, with
  no `if (child)` branches in any handler. CE knows the mode from *how the pipeline was entered*.
- **Validators are edge guards; `call` enters below the edge.** A pipeline's validators
  (`auth_required`, `rate_limit`) run only on HTTP entry. An in-process `call` runs the child's
  *steps* in the parent's already-authorized context and does **not** re-run them. This is what
  lets a child be safely gated over HTTP (change 5) while the feed still calls it from an
  anonymous public-feed request.
- Strict improvement independent of this feature: pipelines become testable as pure functions
  with no HTTP layer.
- This is the enabling refactor; it is small but touches the response/exec core, so it lands
  first and on its own.

### CE change 2 — Loop / `call` primitive (in-process)

A new control-flow handler that maps a child pipeline over an array:

- **Config:** `items` (expression → array), `pipeline` (child ref), `itemAs` (binding name),
  `concurrency` (max children in flight, **default 5**), and error/timeout knobs below.
- **Execution:** invoke the child **in-process** per element in the current request/auth context,
  under a **bounded-concurrency pool** — at most `concurrency` children in flight at once, and the
  next starts the instant one finishes (a sliding window, **not** fixed batches, which would stall
  each batch on its slowest item). Results are collected positionally into an array output.
  `concurrency: 1` = sequential; the default 5 caps bucket load while keeping ≤50 items to ~10
  waves on a cache miss.
- **Per-item isolation:** a child that throws, times out, or returns non-2xx becomes a **`null`**
  slot — it never aborts the loop or the other items.
- **Per-item timeout:** default **5000 ms** (configurable) — a bucket download can't stall the
  feed. On timeout → `null` slot.
- **Recursion guard:** a max call-depth to prevent cyclic child invocation.
- **Result shape:** `[{ ...childBody } | null]`, positionally aligned to `items`.
- **One child per item — an orthogonal `map`, not a limitation.** The loop maps a *single* child
  pipeline over the array. Multiple operations per item are expressed *inside* the child, which is
  itself a full pipeline (many steps) and may itself `call` further pipelines (subject to the
  depth guard). Keeping the loop a pure `map` leaves sequencing to the pipeline where it belongs;
  a loop config that lists several children back-to-back is additive sugar we can add later if the
  ergonomics warrant it.

This is the reusable primitive; the feed is its first consumer.

### CE change 3 — `read_object_text` handler

Reads a storage object's bytes and returns them as text to the pipeline — the capability
`function_handler` fundamentally lacks.

- **Config:** `storageKey` (expression), optional `maxBytes` (guard against pathological files).
- **Output:** `{ text, bytes, mime? }`. Reusable well beyond feeds (any pipeline needing file
  contents).

### CE change 4 — `markdown_render` (+ `sanitize_html`)

- **`markdown_render`** — markdown text → HTML using CE's real Node markdown lib. Config:
  `input` (expression), options (e.g. GFM). Output `{ html }`.
- **`sanitize_html`** — HTML → safe subset (strip scripts/handlers/unsafe attrs) with a real
  sanitizer. Config: `input`, optional allowlist. Output `{ html }`.

Kept **separate** (decided) for composability: the markdown branch is `read → markdown_render →
sanitize_html`; the **Site branch (next)** is `read → sanitize_html` (no markdown step). One
sanitizer serves both branches rather than being duplicated inside each renderer.

> **CE packaging note.** These four are reusable platform primitives, not Handoff-specific. Their
> implementation, tests, and a CE-side ADR/story are captured in `repos/ce/` when the CE plan is
> written; this document specifies their *contracts* as the feed consumes them.

### Handoff change 5 — Child pipeline `resolve-content`

A new pipeline in the `handoff` rule set — a **normal routed pipeline**, no new pipeline kind:

- **Route:** `POST /_internal/resolve-content`, with an **`auth_required` (owner/admin)
  validator** so the HTTP path is not an open blob-reader. The feed never uses this HTTP path — it
  calls the pipeline **in-process** via the loop, which enters below the edge (change 1), so the
  validator is skipped and a public/anonymous feed still resolves content. The parent has already
  access-filtered and passes only viewer-permitted `storageKey`s.
- **Input:** `{ id, storageKey, mime, type }` (supplied per item by the loop).
- **Steps:** `read_object_text` → (`markdown_render` if `mime === 'text/markdown'`) →
  `sanitize_html` → `response { id, html }`. Branching uses the existing step-`condition`
  mechanism. **The markdown→HTML transform is the `markdown_render` CE handler (change 4), not a
  `function_handler`** — hand-rolling a parser in the sandbox is exactly what we're avoiding.
- **Also callable standalone over HTTP** (owner-gated) — e.g. the reader app could render one post
  through it — a direct benefit of it being an ordinary routed pipeline.

### Handoff change 6 — Feed rules (all three copies)

- `selectFeedItems` already yields the surfaced items; expose each item's **`storageKey`** (and
  `mime`/`type`) to the loop input. `storageKey` is on the record — no new data.
- Between selection and XML assembly, the `/feed/*` pipeline runs the **loop** over the items,
  producing an `{ id → html }` map (from the non-null child results).
- `renderFeedXml` gains: for a File whose id has resolved `html`, emit
  `<content:encoded><![CDATA[ … ]]></content:encoded>` **in addition to** the existing
  `<title>`/`<enclosure>`/`<description>`. When there is no `html`, output is **byte-identical to
  today**. Add `xmlns:content="http://purl.org/rss/1.0/modules/content/"` to `<rss>`.
- Keep `feed.ts` and the embedded pipeline port behaviorally identical; extend `feedRule.test.ts`
  parity coverage. The pure `feed.ts` takes the resolved `{ id → html }` map as an argument so it
  stays a pure function (the loop/CE I/O lives only in the pipeline).

### Handoff change 7 — HTTP cache rule on `/feed/*`

- A BFFless **cache rule** on `/feed/*` stamps `Cache-Control` (TTL **5 min**, time-based) so
  reader polls are served from cache and the loop runs only on a miss. The rule sets *headers*;
  the actual store is whatever **shared cache** sits in front — a CDN/edge on the live deployment,
  plus each reader's own HTTP cache. **Origin-offload is only guaranteed when a shared cache
  exists.** If the live deployment has none in front of `/feed/*`, add a **CE-side response cache**
  (rendered feed XML keyed by path + token for the TTL) so the loop truly runs once per TTL
  regardless of client. Confirm against live (open item).
- **Public feeds** cache globally; **token'd private feeds** must key the cache on the `?token=`
  query param (never share a private body across tokens).
- **Invalidation:** time-based expiry only for v1 (RSS tolerates minutes of staleness). Explicit
  cache-bust on folder mutation is a noted future enhancement, not v1.

### Backfill — not required

Because the feed shows only the 50 newest leaves and every new upload renders on demand, the set
of visible un-inlined posts only shrinks as new uploads arrive. Pre-existing markdown files
render the moment the feed rebuilds after this ships (the read is on-demand, not dependent on a
stored field) — so there is **nothing to migrate**. This is a direct payoff of "storage is the
source of truth": there is no per-record state to populate.

## Isolation & interfaces

- **`response_handler` / runner seam (CE)** — the single place "produce" and "transmit" split;
  every pipeline becomes dual-mode here, nothing else changes.
- **Loop primitive (CE)** — array-in, array-out, per-item isolated; knows nothing about feeds.
- **`read_object_text` / `markdown_render` / `sanitize_html` (CE)** — each single-purpose and
  independently reusable.
- **`resolve-content` child (Handoff)** — one clear contract (`{id,storageKey,mime,type}` →
  `{id,html}`), callable from anywhere.
- **`feed.ts`** — stays a pure function; gains the resolved `{ id → html }` map as input, so the
  blob I/O never enters the reference impl. Parity-tested against the pipeline port.

## Sequencing & packaging

Per the CE-in-loop / app-via-Sandcastle split, this ships as **two packaged efforts, CE first:**

1. **CE plan** (`repos/ce/`, interactive) — response decoupling → loop primitive →
   `read_object_text` → `markdown_render`/`sanitize_html`, each with tests and a CE ADR. Nothing
   in Handoff can work until these exist.
2. **Handoff plan** (`repos/apps/`, Sandcastle, `ready-for-agent`) — `resolve-content` child,
   feed-rule changes across the three copies, cache rule, mocks + tests, `CONTEXT.md`/ADR, and the
   **post-merge live-rules MCP sync** (Sandcastle doesn't deploy live proxy rules; fold into the
   shared base set and diff-verify).

Each gets its own spec → plan → implementation cycle; this design is the shared reference.

## Risks

- **Scope — this is a pipeline-engine investment, not just a feed tweak.** Four new/changed CE
  primitives (response split, loop, read, render/sanitize) with the feed as first consumer. That
  is the deliberate trade for reusable composition over a point solution; named so it is chosen
  with eyes open. Mitigation: each primitive is small, single-purpose, and independently useful.
- **Response-decoupling regression.** Lifting the socket-write out of `response_handler` touches
  every pipeline's terminal path. Mitigation: land it first, in isolation, with the invariant
  "HTTP output byte-identical to today" as an explicit test.
- **Cache-miss latency.** A miss reads ≤50 blobs + renders. Mitigation: the bounded-concurrency
  pool (default 5 in flight), a per-item 5 s timeout, and the short-TTL cache keeps misses rare.
  Cap by `maxBytes` in `read_object_text`.
- **Triplication drift.** Live rules can silently diverge from the JSON export. Mitigation: the
  parity test + explicit post-merge MCP sync + diff-verification against live.
- **Sanitization.** Feed HTML is derived from user content and lands in a `<content:encoded>`
  CDATA/HTML context — it must pass through `sanitize_html`, never raw, for both the markdown and
  (later) Site branches.
- **Private-feed cache leakage.** A token'd feed's cache entry must be keyed on the token, or one
  subscriber's private bodies could be served to another. Explicit cache-key requirement in
  change 7.

## Open items for spec review

- **Cache TTL** — **5 min** (confirmed).
- **Per-item timeout** — **5 s** (confirmed; sized for a bucket download).
- **`sanitize_html`** — **separate handler** (confirmed).
- **Caching layer (open)** — the `/feed/*` cache rule only stamps `Cache-Control`; real
  origin-offload depends on a shared cache in front (CDN/edge) or a CE-side response cache.
  Confirm what the live deployment provides; if nothing shared fronts `/feed/*`, add the CE-side
  feed cache described in change 7.
