/**
 * RTK Query endpoint for the public search surface (Task 9). Split out of
 * `videosApi.ts` since it's a public/unauthenticated endpoint with its own
 * response shape (grouped video + moment hits), not part of the admin video
 * CRUD surface — mirrors the existing file layout (one file per feature
 * area, injected onto the shared `recallApi` base).
 *
 * PR-feedback-7: `search` is a `query`, not a `mutation` — the backend rule
 * moved from `POST /api/search { q }` to `GET /api/search?q=` specifically
 * so it's HTTP-cacheable (`Cache-Control: public, max-age=300`; per RFC
 * 9111, conforming caches only ever store GET/HEAD responses, so this had
 * to become a GET regardless of the frontend). Using `query` instead of
 * `mutation` here isn't just "the RTK Query idiom that matches a GET" — it
 * also gets an in-memory result cache + request dedupe on the frontend for
 * free, on top of the HTTP-level cache: a `useSearchQuery('same text')` call
 * from two components (or a re-mount within `keepUnusedDataFor`) shares one
 * cache entry and fires zero extra requests, the same guarantee the browser
 * cache gives repeat/back-forward navigation at the network level.
 */

import { recallApi } from './recallApi'

export type SearchMoment = {
  start: number
  end?: number
  snippet: string
  similarity: number
}

/** A parsed contact-sheet sprite's geometry (PR-feedback-2) — see `src/lib/sprite.ts`
 * for the crop math that turns this + a moment's `start` into a CSS background. */
export type SheetMeta = {
  cols: number
  rows: number
  tileW: number
  tileH: number
  tiles: { t: number }[]
}

export type SearchVideo = {
  videoId: string
  title: string
  youtubeId: string
  duration: number
  /** Site-relative sprite-sheet URL, or `null` if this video has none yet. */
  sheetUrl: string | null
  sheetMeta: SheetMeta | null
  moments: SearchMoment[]
}

export type SearchArgs = { q: string }
export type SearchResponse = { videos: SearchVideo[] }

export const searchApi = recallApi.injectEndpoints({
  endpoints: (builder) => ({
    // GET /api/search?q= -> { videos }. Public, rate-limited (30 req / 5 min
    // per IP), HTTP-cacheable (Cache-Control: public, max-age=300 — see the
    // module doc). No tags — search results aren't cached entities in the
    // invalidation sense, each query is its own transient result set; RTK
    // Query still caches per-arg (`q`) automatically, same as any query
    // endpoint, for the lifetime of `keepUnusedDataFor`.
    search: builder.query<SearchResponse, SearchArgs>({
      query: ({ q }) => `api/search?q=${encodeURIComponent(q)}`,
    }),
  }),
})

export const { useLazySearchQuery } = searchApi
