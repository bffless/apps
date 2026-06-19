# 08 — Transcript search (find-by-meaning → grab → place)

> **Read first:** `00-architecture-and-state.md`. Full design (approved):
> `docs/superpowers/specs/2026-06-10-transcript-search-design.md`.

## What

A search box in the Build diff toolbar that searches the **whole talk** by
meaning — "where am I excited", "where do I say it's time for a bike ride" —
via one LLM call over the timestamped transcript. No index, no vector store:
the transcript is small and already in the browser; the prompt says "read this
text, return matches as strict JSON".

Each result = a span of the original (`start`/`end` seconds, matched snippet,
one-line reason, owning scene). Per result:

- **▶ Play** — preview the original audio for that span (existing hidden
  `<audio>` + `claimPlayback`; the hit's `end` is its own stop bound, not the
  scene window — hits are whole-talk).
- **Word sets** (iteration 2) — each result renders as a full-width **set**
  above both panes: the span's transcript words as selectable chips.
  **Drag-select words in the set** (the Original-pane gesture) → on release
  the words' span (`firstWord.start → lastWord.end`) is grabbed as the
  existing `pendingClip`: New pane enters place mode, click a gap to drop,
  routed to the owning scene via `onAdoptOriginal`. Zero new insert machinery;
  no Grab button, no thumbnails. The page annotates hits with their `words`
  (the viewer only holds the scene slice).

## Order of work (wire-studio-stage)

1. **MSW mock** — `POST /api/search-transcript` in `src/mocks/handlers.ts`
   (gated by `MOCK_STUDIO`): deterministic keyword match over the transcript
   lines, real response shape `{ results: [{ start, end, snippet, reason }] }`.
2. **Pure lib** — `src/lib/search.ts` + `search.test.ts`:
   `buildSearchRequest(query, words, duration)` (reuses `timedTranscript()`
   from `director.ts`) and `toSearchHits(raw, duration)` (clamp into
   `[0, duration]`, `end > start`, drop slivers/garbage, sort, cap ~20).
3. **RTK Query** — `searchTranscript` mutation in `studioApi.ts`, plain sync
   JSON POST like `narrate`/`voiceSay`. **No slice changes** — query/results/
   loading are transient UI, never persisted.
4. **UI** — `TranscriptDiff.tsx`: "⌕ Search" toolbar button (shown when
   `onSearch` is wired) → sticky bar (the snippet-bar pattern) → results list.
   Grab cancels a pending snippet and vice versa (one placement gesture at a
   time). Component tests in `TranscriptDiff.test.tsx`.
5. **Live rule** — BFFless pipeline on `/api/search-transcript`: `replicate`
   handler, `google/gemini-3.1-pro`, **text-only** (no sheets), strict-JSON
   system prompt, server-side clamp mirroring `toSearchHits`. **Sync** — no
   03f jobs flow unless live testing shows timeouts. No validators (story 07).
   Quote string-literal Replicate inputs (they're expressions). Rule id:
   **`504a39bd`** (debug on). Verified live 2026-06-10: literal query → the
   right span; "where I sound excited" → the 'so pumped … amazing' span with a
   sensible reason; nonsense query → `{ "results": [] }`.

## Acceptance

- With mocks on, typing a query whose words appear in the transcript returns
  hits; Play previews the span; Grab → click a New-pane gap inserts an
  original-audio run in the owning scene (amber overlap rules unchanged).
- A hit in *another* scene still grabs and places correctly (placement routes
  by drop time, the span can come from anywhere in the talk).
- Empty/garbage model output coerces to an empty result list, never a crash.
- `npm run build`, `npm run lint`, `npm run test:run` green; one PR.

## Out of scope

- Persisting search history/results; client-side fuzzy matching; searching
  contact sheets or New-pane narration; auth/rate-limit (story 07).
