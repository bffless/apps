# PRD — Rivulet: a self-hostable, Google Reader–style RSS reader

> **Repo:** `repos/apps` (bffless/apps), `apps/reader`. **Build mode:** Sandcastle (async). **Publish as:** `ready-for-agent` GitHub issue — **but only after the CE primitives PRD has landed** (`apps/reader/docs/ce-primitives-prd.md`); this app composes those primitives and cannot run without them. See `apps/reader/CONTEXT.md` (D1–D13) for the full decision record.

## Problem Statement

I miss Google Reader. There's no simple reader I can **deploy on my own BFFless project** that lets me subscribe to feeds, have them **refreshed in the background** so they're already there when I arrive, and read them in a **fast, keyboard-driven river** with read/unread and save-forever state — all private to me. Existing hosted readers own my data and my subscriptions; I want a give-away app I clone, deploy, and own.

## Solution

**Rivulet** — a give-away app in the `bffless-apps` monorepo: a Vite SPA plus a BFFless **proxy-rule-set** backend that *composes* the generic CE primitives (`xml_feed_parse`, `data_upsert_many`, `pipeline_schedules`). It is **personal, single-user per deploy**, **private behind real SuperTokens auth**, and refreshes feeds **in the background** on a schedule. It rebuilds the beloved Reader core loop: a unified river of unread items, folders, keyboard navigation, star-to-keep-forever, oldest-first reading, mark-all-read, OPML import/export, and feed auto-discovery.

## User Stories

1. As a reader, I want to add a feed by URL, so that I can follow a site.
2. As a reader, I want to paste a site's homepage URL and have Rivulet discover its feed, so that I don't need the exact feed URL.
3. As a reader, I want to organize feeds into folders, so that I can group by topic.
4. As a reader, I want a unified "river" of all unread items, so that I can read everything in one place.
5. As a reader, I want per-feed and per-folder views, so that I can focus on one source or topic.
6. As a reader, I want items marked read as I scroll past them, so that my unread count reflects what I've seen.
7. As a reader, I want a "mark all as read" action (for the current view), so that I can declare inbox-zero.
8. As a reader, I want to star an item, so that I keep it forever even after it leaves the feed.
9. As a reader, I want a starred view, so that I can find things I saved.
10. As a reader, I want keyboard navigation (`j`/`k` next/prev, `space` page, `s` star, `m` toggle read, `o`/`enter` open), so that I can move fast.
11. As a reader, I want to sort oldest-first, so that I can read chronologically.
12. As a reader, I want unread counts per feed and folder, so that I can see where new items are.
13. As a reader, I want the item's content rendered safely in a reading pane, so that I can read without leaving the app and without XSS risk.
14. As a reader, I want feeds refreshed automatically in the background, so that new items are already there when I open the app.
15. As a reader, I want a manual "refresh now" action, so that I can pull immediately.
16. As a reader, I want to import an OPML file, so that I can bring my old subscriptions in.
17. As a reader, I want to export my subscriptions as OPML, so that I can take them elsewhere.
18. As a reader, I want an item I've read to disappear from the river but stay retrievable via star, so that the river stays focused.
19. As a reader, I want to unsubscribe from a feed, so that I can prune my list.
20. As a reader, I want to move a feed to a different folder, so that I can reorganize.
21. As a reader, I want the whole app behind login, so that my reading list is private.
22. As the deployer, I want to import the proxy-rule-set and attach it to the app's alias, so that the backend works.
23. As the deployer, I want the refresh schedule configured (e.g. every 15 minutes), so that background refresh runs.
24. As the deployer, I want old read/unstarred items pruned automatically, so that storage stays bounded.

## Implementation Decisions

- **Frontend:** Vite SPA, same shape as `apps/studio` / `apps/handoff`. Decision logic pushed into pure **`lib/*`** modules (OPML parse/generate, feed auto-discovery parse, keyboard-nav state transitions, river ordering, mark-read/unread-count math, a DOMPurify sanitize wrapper). Views: river, reading pane, feed/folder sidebar, add-feed, settings/OPML. State in a store slice.
- **Backend = a proxy-rule-set** (`apps/reader/bffless/reader.proxy-rules.json`), composing CE primitives:
  - `/api/auth/*` — **reverse-proxy** → backend SuperTokens (`localhost:3000/api/auth`). Real sessions. **Not** `/_bffless/auth` (that's for custom domains — see CONTEXT.md D11 and the workspace memory).
  - `/api/feeds` — feed CRUD (data handlers); add-feed and OPML import both insert via **`data_upsert_many`** (dedup by `url`).
  - `/api/items` — query the river; mark read / star via `data_update`.
  - `/api/refresh` — pipeline: `data_query(feeds) → xml_feed_parse(urls) → data_upsert_many(items, dedupKey: guid)`.
  - `/api/discover` — `http_request` proxy that fetches a site's HTML for browser-side feed discovery.
  - All `/api/*` guarded by SuperTokens **`SessionAuthGuard`**.
- **A `pipeline_schedules` schedule** targets `/api/refresh` (e.g. every 15 min); a second schedule targets a prune pipeline (`data_delete` of read + unstarred + older-than-30-days). Scheduled runs execute as **system context**.
- **Data schemas** (CONTEXT.md D10): `feeds { id, url, siteUrl, title, folder?, iconUrl?, lastFetchedAt, lastError?, addedAt }`, `items { id, guid, feedId, title, link, author, publishedAt, summary, content, read, starred, fetchedAt }`. Content **stored raw, sanitized at render** (DOMPurify).
- **Retention:** starred → forever; unread → forever; read + unstarred + older than 30 days → pruned by the scheduled prune pipeline.
- **Depends on** the CE primitives being live: `xml_feed_parse`, `data_upsert_many`, `pipeline_schedules`.

## Testing Decisions

Good tests assert **external behavior** and keep logic in pure functions below the UI. **Runner: Vitest** (Studio's pattern — ~25 `src/lib/*.test.ts` units).

- **`lib/*` pure units:** OPML parse/generate, auto-discovery parse (HTML → feed URL, incl. common-path fallback), keyboard-nav transitions, river ordering (oldest-first), mark-read/unread-count math, sanitize wrapper. Prior art: `apps/studio/src/lib/*.test.ts`.
- **Store slice** tests for read/star/folder state transitions. Prior art: `apps/studio/src/store/studioSlice.test.ts`.
- **Minimal component tests** only where DOM behavior is the contract (e.g. scroll-to-mark-read). Prior art: `apps/studio/src/pages/StudioProjectGuard.test.tsx`.
- Deliberately **not** heavy end-to-end/DOM tests — push logic into `lib/` so the seam stays high.

## Out of Scope

Social/sharing and public shared-or-starred pages · full-text extraction of truncated feeds · cross-item search · per-item tags · recommendations/explore · per-feed refresh cadence · conditional GET · re-syncing edited items (items immutable in v1) · SSRF hardening · multi-user within a deploy. (All catalogued in CONTEXT.md "Deferred to v2+".)

## Further Notes

- **Blocked on the CE primitives PRD** — do not hand to Sandcastle until those have landed and are deployed.
- Working name **Rivulet** (our unified stream is the "River" — internal rhyme). Rename is a directory + `package.json` change.
- After merge, the live `/api/*` proxy rules must be created on the live BFFless set (and secrets/backend wired) — Sandcastle does **not** deploy live proxy rules (see workspace memory). The reverse-proxy auth rule + the two schedules are part of that wiring.
