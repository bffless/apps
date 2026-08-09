/**
 * Canned video fixtures for the mock `/api/videos` (library), `/api/video`
 * (transcript page), and `/api/search` (RAG search) handlers — dev-only, so
 * `pnpm recall:dev`/`?mocks=on` renders the whole public site with no live
 * BFFless project and no paid Replicate calls. Shapes mirror exactly what the
 * real rules return (`PublicVideoMeta`/`PublicVideo` in `store/videosApi.ts`,
 * `SearchResponse` in `store/searchApi.ts`) — the mock is a fixture, not a
 * reimplementation, so there's nothing to keep in sync beyond the field names.
 *
 * All three use real, well-known YouTube ids (safe, stable thumbnails) so
 * `LibraryCard`/`VideoResultCard`'s `img.youtube.com` thumbnail `<img>` tags
 * resolve even though MSW only intercepts `/api/*` and `/_bffless/*`.
 */

type Word = { text: string; start: number; end: number }

/** Lays out words back-to-back with small gaps, deterministic and monotonic. */
function words(text: string, wordsPerSecond = 2.4, gapRatio = 0.15): Word[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  const wordDuration = 1 / wordsPerSecond
  const gap = wordDuration * gapRatio
  let t = 0
  return tokens.map((token) => {
    const start = Math.round(t * 100) / 100
    const end = Math.round((t + wordDuration - gap) * 100) / 100
    t += wordDuration
    return { text: token, start, end }
  })
}

const MOCK_1_TRANSCRIPT_TEXT =
  "Welcome to Recall. In this talk we'll cover how transcript chunking works, " +
  'why publishing a video is the same action as indexing it, and how the chat ' +
  'assistant always cites the exact moment it found an answer. Every chunk carries ' +
  "its own timestamp, so a search result or a chat citation can seek you straight " +
  "to the second that mattered. Let's get started."

export const MOCK_1_WORDS = words(MOCK_1_TRANSCRIPT_TEXT)
const MOCK_1_DURATION = Math.ceil(MOCK_1_WORDS[MOCK_1_WORDS.length - 1]?.end ?? 0) + 2

export const MOCK_VIDEOS = [
  {
    videoId: 'mock-1',
    title: 'Getting started with Recall',
    description: 'A quick tour of transcript chunking, publishing, and cited chat.',
    youtubeId: 'dQw4w9WgXcQ',
    duration: MOCK_1_DURATION,
    publishedAtMs: 1_700_003_000_000,
  },
  {
    videoId: 'mock-2',
    title: 'Deep dive: the chunker',
    description: 'How the 45s/120-word transcript windows are built and overlapped.',
    youtubeId: 'oHg5SJYRHA0',
    duration: 620,
    publishedAtMs: 1_700_002_000_000,
  },
  {
    videoId: 'mock-3',
    title: 'Publishing is indexing',
    description: 'Why a draft video has zero embeddings and can never leak into chat.',
    youtubeId: 'y6120QOlsfU',
    duration: 415,
    publishedAtMs: 1_700_001_000_000,
  },
]

export const MOCK_PUBLIC_VIDEO = {
  videoId: 'mock-1',
  title: MOCK_VIDEOS[0].title,
  description: MOCK_VIDEOS[0].description,
  youtubeId: MOCK_VIDEOS[0].youtubeId,
  duration: MOCK_1_DURATION,
  transcript: { words: MOCK_1_WORDS },
}

/** Fixture hits across two videos, already shaped like `/api/search`'s response. */
export const MOCK_SEARCH_VIDEOS = [
  {
    videoId: 'mock-1',
    title: MOCK_VIDEOS[0].title,
    youtubeId: MOCK_VIDEOS[0].youtubeId,
    duration: MOCK_1_DURATION,
    moments: [
      {
        start: 4.2,
        end: 9.6,
        snippet: 'why publishing a video is the same action as indexing it',
        similarity: 0.91,
      },
      {
        start: 9.6,
        end: 14.8,
        snippet: 'the chat assistant always cites the exact moment it found an answer',
        similarity: 0.84,
      },
    ],
  },
  {
    videoId: 'mock-2',
    title: MOCK_VIDEOS[1].title,
    youtubeId: MOCK_VIDEOS[1].youtubeId,
    duration: MOCK_VIDEOS[1].duration,
    moments: [
      {
        start: 132,
        end: 148,
        snippet: 'each window targets 45 seconds, capped at 120 words',
        similarity: 0.88,
      },
    ],
  },
]
