# PRD — CE: three generic pipeline primitives (`xml_feed_parse`, `data_upsert_many`, `pipeline_schedules`)

> **Repo:** `repos/ce` (bffless/ce). **Build mode:** in-the-loop, interactively. **Sequence:** lands *before* the Rivulet app (see `apps/reader/CONTEXT.md` D13). **Not** a Sandcastle/`ready-for-agent` issue.
>
> Motivated by the Rivulet RSS reader, but every capability here is deliberately **generic** — a future podcast app (podcast feeds are RSS/XML) is the second consumer. No RSS/reader-specific knowledge lands in CE.

## Problem Statement

As a BFFless **pipeline author**, I can't build a background XML-ingestion flow today. A pipeline can fetch a URL (`http_request`), but the response comes back as an **opaque XML string** — there is no handler that parses RSS/Atom/RDF into structured data. Even if I parsed it, I **can't create many records from an array** in one run: handlers are one-record-per-step and the executor has no loop. And I **can't run a pipeline on a schedule** — every cron in CE is hardcoded with a decorator. So any app that periodically pulls external XML feeds and stores their entries — an RSS reader, a podcast subscriber, a price/stock sync — is impossible without bespoke backend code.

## Solution

Add three **generic, reusable** capabilities to CE, none tied to any app:

1. **`xml_feed_parse` handler** — fetch one or more feed URLs (or accept raw XML) and parse RSS 2.0 / Atom / RDF into a normalized, format-neutral **entry** list.
2. **`data_upsert_many` handler** — insert an array of records into a Data-Table schema, **skipping any whose dedup-key value already exists**.
3. **`pipeline_schedules` primitive** — per-project "run pipeline X on this cron cadence," so a pipeline runs unattended.

An app then **composes** them — `data_query → xml_feed_parse → data_upsert_many`, fired by a schedule — to ingest feeds in the background with **no app-specific backend code**. The item-level and feed-level loops live *inside* the two handlers (the established CE pattern), so **no generic-executor changes** (no `foreach`, no subpipelines).

## User Stories

1. As a pipeline author, I want a handler that fetches a feed URL and returns parsed entries, so that I never hand-parse XML.
2. As a pipeline author, I want RSS 2.0, Atom, and RDF parsed into one uniform shape, so that my pipeline is format-agnostic.
3. As a pipeline author, I want to pass multiple feed URLs and have them fetched concurrently (bounded), so that refreshing many feeds finishes inside one execution.
4. As a pipeline author, I want each entry normalized to `{ source, guid, title, link, author, publishedAt, content, summary, enclosures[], extensions{} }`, so that downstream steps have predictable fields.
5. As a podcast-app author, I want `<enclosure>` audio surfaced in `enclosures[]`, so that the same handler serves podcasts.
6. As a podcast-app author, I want namespaced tags (`itunes:*`) preserved in `extensions{}`, so that the parser needn't know about podcasts.
7. As a pipeline author, I want a single malformed feed to record a per-source error and not crash the batch, so that one bad feed can't sink a refresh.
8. As a pipeline author, I want a configurable per-feed fetch timeout, so that slow feeds don't hang the run.
9. As a pipeline author, I want to accept raw XML (not just a URL), so that I can parse a body fetched by a prior step or uploaded by a user.
10. As a pipeline author, I want a handler that inserts an array of records into a schema, so that one run can store many items.
11. As a pipeline author, I want dedup by a configurable key, so that re-running a refresh doesn't duplicate items.
12. As a pipeline author, I want the dedup key to support a fallback chain (e.g. `guid || link || hash`), so that feeds without stable GUIDs don't spawn duplicates.
13. As a pipeline author, I want a field mapping (expressions) from the source array to schema columns, so that the app decides which fields to store.
14. As a pipeline author, I want existing records left untouched on dedup (insert-only, no overwrite), so that per-record state (e.g. read/starred flags) survives refreshes.
15. As a pipeline author, I want a summary of what was inserted vs skipped vs errored, so that I can log/observe a refresh.
16. As a project owner, I want to schedule a pipeline to run on a cron cadence, so that background jobs run unattended.
17. As a project owner, I want the schedule stored as a cron expression, so that I can express "every 6 hours" or "daily at 2am," not just an interval.
18. As a project owner, I want an optional timezone on a schedule, so that "2am" means my 2am.
19. As a project owner, I want to enable/disable a schedule without deleting it.
20. As a project owner, I want to see `lastRunAt`, `nextRunAt`, and `lastError` for a schedule, so that I can tell it's healthy.
21. As a project owner, I want schedules scoped to my project, so that tenants don't see each other's jobs.
22. As a platform operator, I want the scheduler to never double-fire (atomic claim), so that it's safe even if backend replicas are added later.
23. As a platform operator, I want a scheduled run to execute in a system context (no user session), so that it runs unattended with appropriate privileges.
24. As a platform maintainer, I want these primitives free of any RSS/reader knowledge, so that other apps reuse them unchanged.

## Implementation Decisions

- **`xml_feed_parse` handler** — new `HandlerType`. Backed by a pure **`FeedParserService`** (using `fast-xml-parser`, a pure-JS dep) that detects RSS 2.0 / Atom / RDF and maps each to the normalized **entry** shape (handling CDATA, the several date formats, `content:encoded` vs `description`, Atom `<link rel>`, relative→absolute URLs, `<enclosure>`, and namespaced passthrough into `extensions{}`). The handler does bounded-concurrent batch fetch internally (reusing the fetch approach from the existing `http_request` handler — `AbortController` timeout, real `User-Agent`), catching per-source errors. **Config:** `urls` (expression → string or string[]) or `xml` (raw), `concurrency` (default 8), `timeoutMs` (default 30000).
- **`data_upsert_many` handler** — new `HandlerType`. **Config:** `items` (expression → array), `schema` (target Data-Table schema), `dedupKey` (expression evaluated per item, supports a fallback chain), `map` (per-column expressions). Behavior: evaluate dedup keys for the batch, query the schema for already-present keys, insert only the new ones via the data service, leaving existing records untouched. A small `createMany` may be added to the pipeline data service for efficiency (functionally the loop).
- **`pipeline_schedules`** — new Drizzle table modeled on `retention-rules.schema.ts`: `projectId` (FK, cascade), `targetProxyRuleId`, `cronExpression`, `timezone` (default `UTC`), `enabled`, `lastRunAt`, `nextRunAt`, `executionStartedAt`, `lastError`. A new scheduler with `@Cron(EVERY_MINUTE)` delegates to a plain **`runDueSchedules()`** service method: select `enabled && nextRunAt <= now`; **atomically claim** each via a conditional `UPDATE … SET executionStartedAt = now WHERE id = ? AND executionStartedAt IS NULL` and act only if it claimed; trigger `PipelineExecutionService.executePipelineWithDebug` using the synthetic-request + system-user pattern from `onboarding-executor.service.ts`; then set `lastRunAt` and compute `nextRunAt` via `cron-parser` (likely transitive via `@nestjs/schedule`'s `cron` dep; else a tiny add). A per-project CRUD API for schedules.
- **No generic-executor changes.** All looping stays inside the two handlers. **Guardrail:** `xml_feed_parse` must never gain an app-mode flag — app-specific behavior belongs in the normalized output as data, decided by the consuming app.
- **Migration** generated via `drizzle-kit generate` (interactive — the developer runs it; do not hand-write SQL).

## Testing Decisions

Good tests assert **external behavior** and mock the edges — not private implementation. **Runner: Jest**, `*.spec.ts` co-located with source.

- **`FeedParserService`** — pure unit test against a **fixtures folder** (RSS 2.0 / Atom / RDF / podcast-with-enclosure / deliberately-malformed): string in → normalized entries out. Prior art: `src/traffic/access-log.util.spec.ts`, `src/proxy-rules/schema-refs.util.spec.ts`.
- **`xml_feed_parse` handler** — unit test mocking `global.fetch` + the parser; assert on `StepResult.output` and that a bad source yields a per-source error rather than a throw. Prior art: `src/pipelines/handlers/http-request.handler.spec.ts`.
- **`data_upsert_many` handler** — unit test mocking the data service + expression evaluator; assert **insert-vs-skip** dedup behavior via `toHaveBeenCalledWith` and the returned summary. Prior art: `src/pipelines/handlers/file-delete.handler.spec.ts`.
- **`pipeline_schedules` scheduler** — unit test calling the `@Cron`/`runDueSchedules()` method **directly** (no fake timers) with a mocked service; assert due-selection, the atomic-claim/overlap guard, `nextRunAt` advancement, and error-swallowing. Prior art: `src/traffic/traffic-retention.scheduler.spec.ts`.
- **No new integration/real-DB harness.** CE has none today (every service spec mocks `db/client`); standing one up is a separate infra effort and is **out of scope**.

## Out of Scope

- Any RSS-reader/app-specific logic (lives in the Rivulet app PRD).
- A generic executor `foreach`/subpipeline loop primitive (revisit only if a second, different use case demands cross-step looping).
- Conditional GET (`etag`/`Last-Modified`) inside `xml_feed_parse` — deferred to keep the batch interface clean.
- SSRF allow/block-list on outbound fetch — deferred (acceptable while consumers are private/single-user).
- A real/in-memory **test database** and end-to-end pipeline tests asserting rows.
- An admin **UI** for schedules (v1 is API-level; the reader configures its schedule via the API/MCP).
- Multi-replica coordination beyond the atomic claim (CE runs single-instance today).

## Further Notes

- These three primitives are the **critical path** for Rivulet and must land first, in-the-loop, in `repos/ce`.
- Each is independently shippable and testable — they can land as three PRs.
- The whole point of the decomposition (see CONTEXT.md D7): a podcast app reuses `xml_feed_parse` + `data_upsert_many` unchanged, supplying different schemas + field mapping via config.
