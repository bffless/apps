/**
 * Transcript search (story 08) — find-by-meaning over the whole talk.
 *
 * One text-only LLM call reads the timestamped transcript and returns spans
 * matching the producer's query ("where I sound excited", "the bike ride").
 * No index, no vector store — the transcript is small and already here.
 *
 * This is the pure half — request shaping + response coercion — shared by the
 * MSW mock and the real `/api/search-transcript` pipeline (which clamps
 * server-side too; this is the client mirror, same as `director.ts`).
 */

import { timedTranscript } from './director'
import type { TWord } from './transcriptGrid'

/** One hit: a span of the original, the words matched, and why it matched. */
export type SearchHit = {
  start: number
  end: number
  snippet: string
  reason: string
}

/** The request body the front end POSTs to `/api/search-transcript`. */
export type SearchRequest = {
  query: string
  /** Timestamped transcript text (see `timedTranscript`). */
  transcript: string
  /** Source clip duration, so the model (and clamps) know the bounds. */
  duration: number
}

export const MAX_HITS = 20
/** Hits shorter than this are noise — a span has to hold at least a word. */
const MIN_HIT_SECONDS = 0.3

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function buildSearchRequest(query: string, words: TWord[], duration: number): SearchRequest {
  return { query: query.trim(), transcript: timedTranscript(words), duration }
}

/**
 * Coerce the model's raw output into clean hits: accept a bare array or a
 * `{ results }` envelope, clamp every span into `[0, duration]`, drop slivers
 * and garbage, sort ascending, cap the count. Never trust the model's numbers.
 */
export function toSearchHits(raw: unknown, duration: number): SearchHit[] {
  const list = Array.isArray(raw) ? raw : (raw as { results?: unknown } | null)?.results
  if (!Array.isArray(list)) return []
  const bound = Number.isFinite(duration) && duration > 0 ? duration : Infinity

  const hits: SearchHit[] = []
  for (const r of list) {
    if (typeof r !== 'object' || r === null) continue
    const o = r as Record<string, unknown>
    const start = Math.min(Math.max(num(o.start), 0), bound)
    const end = Math.min(Math.max(num(o.end), 0), bound)
    if (end - start < MIN_HIT_SECONDS) continue
    hits.push({ start, end, snippet: str(o.snippet).trim(), reason: str(o.reason).trim() })
  }
  hits.sort((a, b) => a.start - b.start)
  return hits.slice(0, MAX_HITS)
}
