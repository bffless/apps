/**
 * RTK Query endpoint for the public search surface (Task 9). Split out of
 * `videosApi.ts` since it's a public/unauthenticated endpoint with its own
 * response shape (grouped video + moment hits), not part of the admin video
 * CRUD surface — mirrors the existing file layout (one file per feature
 * area, injected onto the shared `recallApi` base).
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
    // POST /api/search { q } -> { videos }. Public, rate-limited
    // (30 req / 5 min per IP). No tags — search results aren't cached
    // entities, each query is its own transient result set.
    search: builder.mutation<SearchResponse, SearchArgs>({
      query: (body) => ({ url: 'api/search', method: 'POST', body }),
    }),
  }),
})

export const { useSearchMutation } = searchApi
