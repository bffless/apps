# Feed Content Bodies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inline a post's rendered body into the Handoff RSS feed as `<content:encoded>`, sourced on demand from storage (no DB copy), via four reusable CE pipeline primitives consumed by a `resolve-content` child pipeline the feed loops over.

**Architecture:** Storage stays the single source of truth; rendered HTML is a cached *response*, never materialized. CE gains a response/transmit split (so any pipeline is callable in-process), an in-process loop/`call` primitive, a `read_object_text` handler, and `markdown_render` + `sanitize_html` handlers. Handoff adds a `resolve-content` child pipeline (`{id,storageKey,mime,type}` → `{id,html}`); the `/feed/*` pipeline loops it over the ≤50 surfaced items and injects the resulting HTML additively. A `/feed/*` cache rule keeps the loop on the cache-miss path only.

**Tech Stack:** CE — NestJS + TypeScript pipeline engine (`repos/ce/`, real Node: a markdown lib + HTML sanitizer). Handoff — React 18 + Vite + TS, Vitest, MSW mocks, BFFless proxy-rule pipelines (embedded `function_handler` JS in `bffless/handoff.proxy-rules.json`), synced to live via the `j5s-dev` MCP.

**Reference spec:** `apps/handoff/docs/superpowers/specs/2026-07-08-feed-content-bodies-design.md`

## Global Constraints

- **Two packaged efforts, CE first.** Phase 1 (CE primitives, `repos/ce/`, interactive) MUST land and be released before Phase 2 (Handoff, `repos/apps/`, Sandcastle, `ready-for-agent`) can work — nothing in Handoff functions until the CE handlers exist. Package and PR them separately.
- **Storage is the sole source of truth.** Do NOT add a rendered-HTML column to `handoff_nodes` or any DB record. Content is read from the bucket on demand. There is therefore **no backfill/migration** — pre-existing markdown renders the moment the feed rebuilds.
- **Feed logic is triplicated and MUST stay behaviorally identical:** `src/lib/feed.ts` (reference impl), the embedded port in `bffless/handoff.proxy-rules.json` (the `/feed/*` rule), and the live BFFless rules. `src/lib/feedRule.test.ts` pins reference↔pipeline parity. Live rules are synced via MCP post-merge (Task 12), never by Sandcastle.
- **`<content:encoded>` is purely additive.** When an item has no resolved `html`, feed output must be **byte-identical to today**. Every feed test must include a "no html → unchanged" case.
- **Confirmed values (spec):** cache TTL **5 min** (time-based); per-item loop timeout **5000 ms**; `sanitize_html` is a **separate** handler; markdown now, Site HTML next (design the child's branch seam, don't implement Site).
- **Sanitize, never raw.** Any HTML placed in `<content:encoded>` must pass through `sanitize_html` first.
- **Private-feed cache key.** A token'd `/feed/*` response must be cached keyed on `?token=`; never share a private body across tokens.
- **OPEN ITEM — resolve before finalizing Task 10/Phase-1 cache work:** the `/feed/*` cache rule only stamps `Cache-Control`; real origin-offload needs a shared cache (CDN/edge) in front of `handoff.j5s.dev`, or a CE-side response cache. **Verify what fronts `/feed/*` on the live deployment.** If nothing shared does, add a CE-side feed-response cache (rendered XML keyed by path+token for the TTL) as an extra Phase-1 task before relying on "the loop runs once per TTL."
- After any edit to `bffless/handoff.proxy-rules.json`, verify it parses: `node -e "JSON.parse(require('fs').readFileSync('bffless/handoff.proxy-rules.json','utf8'));console.log('ok')"`.
- Handoff commands run from `apps/handoff/`. Test cmd: `pnpm --filter handoff test` (or `pnpm test` inside `apps/handoff`).

---

# Phase 1 — CE pipeline primitives (`repos/ce/`)

> **Where these live (confirm during the CE session):** the pipeline handler registry and per-handler implementations are under `repos/ce/apps/backend/src/` (the proxy-rule/pipeline execution domain — search for the existing `function_handler` / `response_handler` / `file_serve_handler` implementations and the handler-type union/enum they register against). The admin UI handler picker and any handler-type schema also need the new types registered. **Each task below is specified at the contract/behavior level; confirm exact files, the handler-registration seam, and the response-object type during the CE session before writing code.**

### Task 1: Response decoupling — produce vs transmit

**Files:**
- Modify (confirm): the pipeline executor + `response_handler` implementation + the HTTP entrypoint that runs a pipeline for an incoming request (`repos/ce/apps/backend/src/**` pipeline domain).
- Test: CE pipeline-executor unit/integration tests (co-located with the executor).

**Interfaces:**
- Produces: a `PipelineResponse` value `{ status: number; headers: Record<string,string>; body: string | Buffer }` returned by executing a pipeline. `response_handler` **populates** this value; it no longer writes to the Express `res`. The HTTP entrypoint is the only place that flushes a `PipelineResponse` to the socket. A new **in-process runner** returns the `PipelineResponse` to its caller instead of flushing (consumed by Task 2).
- Invariant: for every existing pipeline, the bytes/status/headers written over HTTP are **identical to before this change**.

- [ ] **Step 1: Characterize current output (golden test).** Add a test that runs a representative existing pipeline (e.g. an existing Handoff-style `response_handler` pipeline fixture) through the HTTP path and snapshots `{status, headers, body}`. This is the "byte-identical" guard.
- [ ] **Step 2: Run it — passes today** (establishes the golden baseline).
- [ ] **Step 3: Introduce `PipelineResponse`.** Define the type and make the executor return it. `response_handler` writes into it (status/headers/body from its config) rather than calling `res.*`.
- [ ] **Step 4: Split the runner.** HTTP entrypoint: execute pipeline → get `PipelineResponse` → flush to `res` (this is the ONLY socket write). Add an exported `runPipelineInProcess(ref, input, ctx): Promise<PipelineResponse>` that executes and returns without any `res`.
- [ ] **Step 5: Run the golden test — still passes** (HTTP output unchanged). Add a direct unit test asserting `runPipelineInProcess` returns the `PipelineResponse` object and performs no socket write.
- [ ] **Step 6: Commit.** `feat(ce): decouple pipeline response from transmission (produce vs flush)`

**Definition of done:** existing pipelines emit byte-identical HTTP responses; a pipeline can be executed in-process and yields a `PipelineResponse` value; no handler references `res` except the HTTP entrypoint.

---

### Task 2: In-process loop / `call` primitive

**Files:**
- Create (confirm): a new `loop` (a.k.a. `map`/`call`) handler in the CE handler registry; register the handler type.
- Test: handler unit tests.

**Interfaces:**
- Consumes: `runPipelineInProcess` (Task 1).
- Produces: a handler type (proposed `loop`) with config `{ items: <expression → array>, pipeline: <child ref>, itemAs?: string (default "item"), timeoutMs?: number (default 5000), maxDepth?: number (default e.g. 4) }`. Output: an **array positionally aligned to `items`**, each slot the child's `PipelineResponse.body` parsed to JSON on 2xx, else `null`.
- Semantics: for each element, bind `itemAs` and run the child via `runPipelineInProcess` in the current request/auth context. **Per-item isolation:** a child that throws, exceeds `timeoutMs`, or returns non-2xx → `null` slot; never aborts the loop. **Recursion guard:** track call depth in the exec context; exceeding `maxDepth` fails that item to `null` (and logs). Children may run concurrently (bounded); order of the result array follows `items`.

- [ ] **Step 1: Write failing tests** covering: (a) maps a child over `[a,b,c]` → `[ra,rb,rc]` in order; (b) a child that throws → that slot `null`, others intact; (c) a child that sleeps past `timeoutMs` → `null` slot; (d) a child returning status 500 → `null` slot; (e) depth beyond `maxDepth` → `null` + logged.
- [ ] **Step 2: Run — fails** (handler type unknown).
- [ ] **Step 3: Implement the handler** per the semantics above; register the type in the handler registry + admin picker/schema.
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Commit.** `feat(ce): in-process loop primitive mapping a child pipeline over an array`

**Definition of done:** the loop maps a child pipeline in-process with per-item isolation, a 5000 ms default timeout, and a depth guard; results array aligns to inputs with `null` for failures.

---

### Task 3: `read_object_text` handler

**Files:**
- Create (confirm): `read_object_text` handler; register the type. Reuse the storage-adapter interface the existing `file_serve_handler` / `signed_url` handlers use to read a bucket object.
- Test: handler unit tests (with a stub storage adapter).

**Interfaces:**
- Produces: handler type `read_object_text`, config `{ storageKey: <expression>, maxBytes?: number (default e.g. 1_048_576) }`. Output `{ text: string, bytes: number, mime?: string }`. Reads the object via the storage adapter; if the object exceeds `maxBytes`, fail the step (→ becomes a `null` slot when run under the loop). No auth of its own — callers gate access before invoking (the feed pre-filters to viewable items).

- [ ] **Step 1: Write failing tests:** (a) reads a stub object's bytes → `{text, bytes}`; (b) object over `maxBytes` → step error; (c) missing object → step error.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** using the storage-adapter read; enforce `maxBytes`.
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Commit.** `feat(ce): read_object_text handler (bucket object → text, maxBytes guard)`

**Definition of done:** a pipeline step can read a storage object's text with a size guard, using the existing storage adapter.

---

### Task 4: `markdown_render` handler

**Files:**
- Create (confirm): `markdown_render` handler; register the type. Add a markdown library dependency to the CE backend (`repos/ce/apps/backend/package.json`) if none exists — confirm what's already present before adding.
- Test: handler unit tests.

**Interfaces:**
- Produces: handler type `markdown_render`, config `{ input: <expression>, gfm?: boolean (default true) }`. Output `{ html: string }`. Renders markdown → HTML with a real Node markdown lib. **Does not sanitize** (that's Task 5) — kept single-purpose.

- [ ] **Step 1: Write failing tests:** (a) `# H` → `<h1>H</h1>` (assert structurally, not brittle whitespace); (b) a fenced code block renders to `<pre><code>`; (c) empty input → `{ html: '' }`.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** with the chosen lib.
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Commit.** `feat(ce): markdown_render handler (markdown → HTML)`

**Definition of done:** a pipeline step renders markdown to HTML; output is unsanitized by design.

---

### Task 5: `sanitize_html` handler

**Files:**
- Create (confirm): `sanitize_html` handler; register the type. Add an HTML sanitizer dependency (e.g. an allowlist sanitizer) to the CE backend if none exists — confirm first.
- Test: handler unit tests.

**Interfaces:**
- Produces: handler type `sanitize_html`, config `{ input: <expression>, allow?: <optional allowlist override> }`. Output `{ html: string }`. Strips `<script>`, event handlers, `javascript:` URLs, and other unsafe constructs to a safe allowlist. Reused by both the markdown branch and the (future) Site branch.

- [ ] **Step 1: Write failing tests:** (a) `<script>alert(1)</script><p>ok</p>` → script removed, `<p>ok</p>` kept; (b) `<a href="javascript:x">` → href stripped/neutralized; (c) `<img onerror=...>` → handler attribute removed; (d) plain formatting (`<strong>`, `<ul>`, `<a href="https://…">`) preserved.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement** with the chosen sanitizer + allowlist.
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Commit.** `feat(ce): sanitize_html handler (allowlist HTML sanitizer)`

**Definition of done:** a pipeline step sanitizes HTML to a safe allowlist; scripts/handlers/unsafe URLs removed, safe formatting preserved.

---

### Task 6: CE docs — ADR for the reusable primitives

**Files:**
- Create: a CE-side ADR/story capturing these four primitives (`repos/ce/` — confirm the ADR/story location, e.g. `repos/platform/stories/` is Platform; CE may use `repos/ce/docs/` — match the CE repo's own convention).

**Interfaces:** none (documentation).

- [ ] **Step 1: Write the ADR** recording: response/transmit split (any pipeline callable, no "callable" flag); in-process loop primitive (map + per-item isolation + timeout + depth guard); `read_object_text`; `markdown_render` + separate `sanitize_html`. Note the feed is the first consumer and the in-process (not subrequest) decision.
- [ ] **Step 2: Commit.** `docs(ce): ADR — reusable pipeline composition primitives`

**Phase 1 definition of done / verification:** all four handler types registered and unit-tested; existing pipelines byte-identical over HTTP (Task 1 golden test green); a throwaway pipeline `read_object_text → markdown_render → sanitize_html` renders a sample markdown blob to safe HTML; the loop maps that child over a 3-item array with one deliberately-failing item yielding a `null` slot. Release CE so Phase 2 can consume the new handlers.

---

# Phase 2 — Handoff feed consumer (`repos/apps/`)

> Runs in the existing worktree `/home/rico/bffless/repos/apps-handoff-feed-content-bodies` on branch `handoff-feed-content-bodies`. Never switch the shared `repos/apps` checkout's branch.

### Task 7: `resolve-content` child pipeline

**Files:**
- Modify: `bffless/handoff.proxy-rules.json` (add a new pipeline rule `POST /api/internal/resolve-content`, or a nameable child pipeline the loop can reference — confirm how the loop's `pipeline` ref addresses a child in the live engine during Phase 1; expose it as a normal rule so it is also independently callable).
- Test: `src/lib/resolveContentRule.test.ts` (assert the rule's steps/shape from the JSON, mirroring how `feedRule.test.ts` reads the JSON).

**Interfaces:**
- Consumes: CE handlers `read_object_text`, `markdown_render`, `sanitize_html` (Phase 1).
- Produces: child pipeline with input `{ id, storageKey, mime, type }` → `response { id, html }`. Steps: `read_object_text(storageKey)` → `markdown_render(text)` *[condition: `mime === 'text/markdown'`]* → `sanitize_html(html)` → `response_handler` returning `{ id, html }`. On any step failure the loop records a `null` slot (Task 2 semantics), so the child needs no error branch. **Leave a commented seam** for the Site branch (`type === 'site'` → `read_object_text(entryKey)` → `sanitize_html`) — do NOT implement Site now.

- [ ] **Step 1: Write the failing structural test.** In `src/lib/resolveContentRule.test.ts`, load `handoff.proxy-rules.json`, find the `resolve-content` rule, assert: it exists; its steps include `read_object_text`, `markdown_render` (with a `text/markdown` condition), and `sanitize_html`; the terminal `response_handler` emits `id` + `html`.
- [ ] **Step 2: Run — fails** (rule absent).
- [ ] **Step 3: Add the rule** to the `rules` array with the four steps and the markdown condition. Give it a unique `order` and `isEnabled: true`. Use the `${input.storageKey}` / `${steps.read.text}` expression forms the engine uses (confirm exact expression syntax against a sibling handler in the file).
- [ ] **Step 4: Validate JSON + run test.** `node -e "JSON.parse(...)"` → `ok`; `pnpm test -- src/lib/resolveContentRule.test.ts` → PASS.
- [ ] **Step 5: Commit.** `feat(handoff): resolve-content child pipeline (markdown → safe HTML)`

---

### Task 8: Feed reference impl — additive `<content:encoded>`

**Files:**
- Modify: `src/lib/feed.ts`
- Test: `src/lib/feed.test.ts`

**Interfaces:**
- Consumes: `FeedItem` (already carries `id`, `type`, `mime`, `path`; `selectFeedItems` already surfaces `storageKey`-equivalent via the node record — confirm `storageKey` is on `FeedItem`; if not, add it in `selectFeedItems` like `title`/`description` were added, no new data).
- Produces: `renderFeedXml(items, ctx, bodies?)` gains an optional third arg `bodies?: Record<string,string>` (id → sanitized HTML). When `bodies[it.id]` is present for a File, emit `<content:encoded><![CDATA[ … ]]></content:encoded>` **in addition to** the existing `<title>`/`<enclosure>`/`<description>`. Add `xmlns:content="http://purl.org/rss/1.0/modules/content/"` to the `<rss>` open tag. When `bodies` is absent/empty, output is **byte-identical to today**. `feed.ts` stays pure — it never reads blobs; the map is passed in.

- [ ] **Step 1: Write failing tests:** (a) `renderFeedXml(items, ctx, { id1: '<p>hi</p>' })` contains `xmlns:content=` and `<content:encoded><![CDATA[<p>hi</p>]]></content:encoded>` for the item with `id1`, and still contains its existing `<enclosure>`; (b) `renderFeedXml(items, ctx)` (no bodies) is **byte-identical** to the pre-change output for the same items (snapshot the current output first); (c) an id in `bodies` that is a Site or not in `items` is ignored.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Add the `content` namespace** to the `<rss>` tag and the optional `bodies` param; inject `<content:encoded>` for `bodies[it.id]` in the File branch, additively.
- [ ] **Step 4: Run — passes** (byte-identical case green).
- [ ] **Step 5: Commit.** `feat(handoff): additive <content:encoded> in feed reference impl`

---

### Task 9: Feed pipeline port — loop resolve-content + inject bodies

**Files:**
- Modify: `bffless/handoff.proxy-rules.json` (the `/feed/*` rule): add the loop step and the `<content:encoded>` injection to the embedded render, mirroring Task 8.
- Test: `src/lib/feedRule.test.ts` (extend parity coverage).

**Interfaces:**
- Consumes: the `select` output (surfaced items with `id`/`storageKey`/`mime`/`type`); Task 7's `resolve-content`; Task 2's `loop` handler.
- Produces: between select and XML assembly, a `loop` step maps `resolve-content` over the surfaced File items → array of `{id,html}|null`; a small `function_handler` folds the non-null results into an `{id→html}` map; the embedded render injects `<content:encoded>` exactly as `feed.ts` does. Parity with `feed.ts` is asserted (feeding the same `bodies` map to both).

- [ ] **Step 1: Write failing parity test.** In `feedRule.test.ts`, add a fixture where the pipeline is given a resolvable markdown item and assert the pipeline XML contains the same `<content:encoded>` block the reference `renderFeedXml(..., bodies)` produces, and that with no resolvable bodies the pipeline XML is byte-identical to today.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Add the loop + fold + injection** to the `/feed/*` rule. The loop's `items` = the surfaced File items; `pipeline` = `resolve-content`; `itemAs` = `item`; `timeoutMs` 5000. Fold `[{id,html}|null]` → `{id→html}` in a `function_handler`. Extend the embedded render (the `xmlEscape`/enclosure block) to append `<content:encoded>` when the map has the id, and add `xmlns:content` to `<rss>`.
- [ ] **Step 4: Validate JSON + run tests.** `node -e "JSON.parse(...)"` → `ok`; `pnpm test -- src/lib/feedRule.test.ts src/lib/feed.test.ts` → PASS.
- [ ] **Step 5: Commit.** `feat(handoff): /feed/* loops resolve-content and injects content:encoded`

---

### Task 10: Cache rule on `/feed/*`

**Files:**
- Modify: `bffless/handoff.proxy-rules.json` (add a cache rule for `/feed/*`) — confirm whether cache rules live in this export or are set via MCP only; if MCP-only, this task is the spec/checklist and the apply happens in Task 12.
- Test: `src/lib/feedCacheRule.test.ts` (assert the rule's TTL + token-keying if represented in the JSON).

**Interfaces:**
- Produces: `/feed/*` responses carry `Cache-Control` with `max-age=300` (5 min). Public feeds cache globally; token'd feeds MUST vary/key on `?token=` (never share a private body). **See the Global Constraints OPEN ITEM** — confirm a shared cache fronts `/feed/*` before claiming origin-offload; if none, escalate the CE-side response cache task into Phase 1.

- [ ] **Step 1: Write failing test** asserting the cache rule for `/feed/*` exists with a 300 s TTL and token-aware keying (if the JSON models cache rules).
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Add the cache rule** (or document the MCP `create_cache_rule` params in this task for Task 12 if cache rules are MCP-only).
- [ ] **Step 4: Validate JSON + run test.**
- [ ] **Step 5: Commit.** `feat(handoff): cache rule for /feed/* (5 min, token-keyed)`

---

### Task 11: Docs — glossary + ADR

**Files:**
- Modify: `CONTEXT.md`
- Create: `docs/adr/0010-feed-content-bodies.md` (confirm next ADR number; 0009 is content-title-description)

**Interfaces:** none.

- [ ] **Step 1: Glossary.** In `CONTEXT.md`, add to the Feeds section: **Content body** — a feed item's `<content:encoded>` HTML, rendered on demand from the file's bytes in storage (never stored in the DB); markdown now, Site HTML next. Note storage is the single source of truth.
- [ ] **Step 2: ADR-0010** recording: storage-as-sole-source-of-truth (no DB materialization → no backfill); on-demand resolution via an in-process loop + `resolve-content` child over the CE primitives; additive `<content:encoded>` degrading to today's feed; caching the response (not the content); markdown-now/Site-next.
- [ ] **Step 3: Commit.** `docs(handoff): content-body glossary + ADR-0010`

---

### Task 12: Post-merge — sync live rules + verify (human-gated)

**Files:** none (operational; via the `j5s-dev` MCP against the live `handoff` set after the PR merges).

> NOT a code commit. Sandcastle does not deploy live proxy rules. Checklist for the maintainer; keep in the PR description.

- [ ] **Step 1: Confirm CE is deployed** with the four new handler types (Phase 1 released) — the live feed loop depends on them.
- [ ] **Step 2: Resolve the caching OPEN ITEM.** Check whether a shared CDN/edge fronts `handoff.j5s.dev/feed/*`. If yes → the cache rule suffices. If no → deploy the CE-side feed-response cache (Phase-1 follow-up) before relying on cache-miss-only loop execution.
- [ ] **Step 3: Diff live vs repo.** `get_proxy_rule_set` for the live `handoff` set; compare the `/feed/*` rule and confirm `resolve-content` + the cache rule are absent.
- [ ] **Step 4: Apply.** Create `resolve-content` (Task 7 JSON), update the `/feed/*` rule (Task 9 loop + injection), and add the `/feed/*` cache rule (Task 10 params). Fold into the shared base set (prod + preview aliases share it); do not attach a preview-only override.
- [ ] **Step 5: Verify end-to-end.** Upload a markdown post to a public folder; fetch `https://handoff.j5s.dev/feed.xml` (or the folder feed) and confirm the item now carries `<content:encoded>` with the rendered, sanitized body; confirm a `<script>` in the source is stripped; confirm an item whose resolve fails still renders (title + enclosure, feed 200). Poll twice and confirm the cache serves the second hit.
- [ ] **Step 6: Drift check.** Confirm the repo JSON matches what was applied; if not, reconcile and open a `chore(handoff): sync rules export with live set` PR.

**Phase 2 definition of done / verification:** `pnpm --filter handoff test` green (parity + byte-identical-when-no-bodies cases); `tsc -b` + lint clean; live feed shows a rendered, sanitized markdown body inline, degrades gracefully per item, and serves polls from cache.

---

## Self-Review

**Spec coverage:**
- CE change 1 (response decoupling) → Task 1 ✓
- CE change 2 (in-process loop) → Task 2 ✓
- CE change 3 (`read_object_text`) → Task 3 ✓
- CE change 4 (`markdown_render` + separate `sanitize_html`) → Tasks 4–5 ✓
- CE ADR for primitives → Task 6 ✓
- Handoff change 5 (`resolve-content` child) → Task 7 ✓
- Handoff change 6 (feed rules, all copies; `feed.ts` pure via injected map; `xmlns:content` + additive `<content:encoded>`) → Tasks 8 (reference) + 9 (port); live copy → Task 12 ✓
- Handoff change 7 (cache rule, token-keyed, TTL 5 min) → Task 10 (+ OPEN ITEM tracked in Global Constraints & Task 12) ✓
- Backfill not required → encoded as a Global Constraint; no task, by design ✓
- Docs (glossary + ADR) → Task 11 ✓
- Live sync (MCP, human-gated) → Task 12 ✓
- Markdown now / Site next → Task 7 leaves the Site branch as a commented seam, unimplemented ✓

**Placeholder scan:** Phase 1 tasks are intentionally at contract/behavior level (per the two-repo split — CE internals are confirmed in the CE session), with concrete test intents and exact handler contracts/configs; each flags "confirm exact CE integration points." Phase 2 tasks carry exact files, expression/JSON edits, and byte-identical guards. No "TBD/handle edge cases" left as work.

**Type consistency:** `PipelineResponse {status,headers,body}` (Task 1) is returned by `runPipelineInProcess` (Task 1) and consumed by the loop (Task 2), whose result is `[{...body}|null]`. `resolve-content` I/O `{id,storageKey,mime,type}→{id,html}` (Task 7) matches the loop input built in Task 9 and the `bodies: Record<string,string>` (id→html) consumed by `renderFeedXml(items, ctx, bodies?)` in Tasks 8–9. `read_object_text→{text,bytes,mime?}`, `markdown_render→{html}`, `sanitize_html→{html}` chain consistently in Task 7.

**Open item flagged:** the caching-layer question (shared cache vs CE-side response cache) is called out in Global Constraints and gated in Task 10 + Task 12 Step 2 — it must be resolved before the "loop runs once per TTL" performance claim holds.
