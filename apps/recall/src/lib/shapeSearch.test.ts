import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

type Hit = Record<string, unknown>
type Moment = { start: number; end?: number; snippet: string; similarity: number }
type SheetMeta = { cols: number; rows: number; tileW: number; tileH: number; tiles: { t: number }[] }
type SearchVideo = {
  videoId: string
  title: string
  youtubeId: string
  duration: number
  sheetUrl: string | null
  sheetMeta: SheetMeta | null
  moments: Moment[]
}
type ShapeOutput = { videos: SearchVideo[] }

const shapeFnSrc = loadFnSource('api/search/post/shape.fn.js')

type VideoRow = Record<string, unknown>

// PR-feedback-6: sheet_path/sheet_meta are sourced from `steps.videos` (a
// plain data_query over recall_videos), NOT from the vector_search hit
// itself — see the fix's commentary in shape.fn.js and rule.yaml for why.
function run(hits: Hit[], videoRows: VideoRow[] = []): ShapeOutput {
  return runFn(shapeFnSrc, { steps: { search: hits, videos: videoRows } }) as ShapeOutput
}

function videoRow(overrides: VideoRow = {}): VideoRow {
  return { id: 'v1', ...overrides }
}

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

function hit(overrides: Partial<Hit> = {}): Hit {
  return {
    id: 'v1',
    similarity: 0.5,
    chunkText: '[t=10s] hello world',
    title: 'Intro to Recall',
    youtube_url: YT,
    duration: 600,
    status: 'published',
    ...overrides,
  }
}

describe('shape.fn.js', () => {
  test('groups multiple hits for the same video into one entry', () => {
    const out = run([
      hit({ chunkText: '[t=10s] a', similarity: 0.5 }),
      hit({ chunkText: '[t=20s] b', similarity: 0.6 }),
    ])
    expect(out.videos).toHaveLength(1)
    expect(out.videos[0].videoId).toBe('v1')
    expect(out.videos[0].moments).toHaveLength(2)
  })

  test('caps moments at 4 per video, keeping the highest-similarity ones', () => {
    const hits = [0.1, 0.9, 0.3, 0.8, 0.2, 0.7].map((sim, i) =>
      hit({ chunkText: `[t=${i * 10}s] chunk ${i}`, similarity: sim }),
    )
    const out = run(hits)
    expect(out.videos[0].moments).toHaveLength(4)
    expect(out.videos[0].moments.map((m) => m.similarity)).toEqual([0.9, 0.8, 0.7, 0.3])
  })

  test('parses the [t=Ns] prefix when chunkMetadata is absent, and strips it from the snippet', () => {
    const out = run([hit({ chunkText: '[t=754s] some spoken words' })])
    expect(out.videos[0].moments[0]).toMatchObject({ start: 754, snippet: 'some spoken words' })
    expect(out.videos[0].moments[0].snippet).not.toContain('[t=')
  })

  test('prefers chunkMetadata.start/end over the prefix, and still strips the prefix', () => {
    const out = run([
      hit({
        chunkText: '[t=754s] some spoken words',
        chunkMetadata: { start: 754.4, end: 799.1 },
      }),
    ])
    expect(out.videos[0].moments[0]).toEqual({
      start: 754.4,
      end: 799.1,
      snippet: 'some spoken words',
      similarity: 0.5,
    })
  })

  test('a hit with neither chunkMetadata nor a parseable prefix is skipped', () => {
    const out = run([hit({ chunkText: 'no timestamp prefix here' })])
    expect(out.videos).toHaveLength(0)
  })

  test('extracts youtubeId from youtube_url', () => {
    const out = run([hit({ youtube_url: 'https://youtu.be/dQw4w9WgXcQ?t=5' })])
    expect(out.videos[0].youtubeId).toBe('dQw4w9WgXcQ')
  })

  test('a hit with no extractable youtube id is skipped', () => {
    const out = run([hit({ youtube_url: 'https://vimeo.com/12345' })])
    expect(out.videos).toHaveLength(0)
  })

  test('drops hits whose status is not published (defense-in-depth)', () => {
    const out = run([hit({ id: 'v1', status: 'transcribed' }), hit({ id: 'v2', status: 'published' })])
    expect(out.videos).toHaveLength(1)
    expect(out.videos[0].videoId).toBe('v2')
  })

  test('sorts videos by their best moment similarity, descending', () => {
    const out = run([
      hit({ id: 'v1', chunkText: '[t=1s] a', similarity: 0.4 }),
      hit({ id: 'v2', chunkText: '[t=1s] b', similarity: 0.9 }),
      hit({ id: 'v3', chunkText: '[t=1s] c', similarity: 0.6 }),
    ])
    expect(out.videos.map((v) => v.videoId)).toEqual(['v2', 'v3', 'v1'])
  })

  test('within a video, moments are sorted by similarity descending', () => {
    const out = run([
      hit({ chunkText: '[t=1s] a', similarity: 0.2 }),
      hit({ chunkText: '[t=2s] b', similarity: 0.9 }),
      hit({ chunkText: '[t=3s] c', similarity: 0.5 }),
    ])
    expect(out.videos[0].moments.map((m) => m.similarity)).toEqual([0.9, 0.5, 0.2])
  })

  test('an empty hit list returns an empty videos array', () => {
    expect(run([])).toEqual({ videos: [] })
  })

  test('normalizes sheet_path into a leading-slash sheetUrl and parses sheet_meta JSON, sourced from steps.videos', () => {
    const meta: SheetMeta = { cols: 5, rows: 2, tileW: 320, tileH: 180, tiles: [{ t: 1 }] }
    const out = run(
      [hit()],
      [videoRow({ sheet_path: 'api/uploads/sheets/v1/x.jpg', sheet_meta: JSON.stringify(meta) })],
    )
    expect(out.videos[0].sheetUrl).toBe('/api/uploads/sheets/v1/x.jpg')
    expect(out.videos[0].sheetMeta).toEqual(meta)
  })

  test('leaves an already-leading-slash sheet_path untouched', () => {
    const out = run([hit()], [videoRow({ sheet_path: '/api/uploads/sheets/v1/x.jpg' })])
    expect(out.videos[0].sheetUrl).toBe('/api/uploads/sheets/v1/x.jpg')
  })

  test('sheetUrl/sheetMeta are null when there is no matching video row (or no sheet fields on it)', () => {
    expect(run([hit()]).videos[0].sheetUrl).toBeNull()
    expect(run([hit()]).videos[0].sheetMeta).toBeNull()
    expect(run([hit()], [videoRow()]).videos[0].sheetMeta).toBeNull()
  })

  test('sheetMeta is null when sheet_meta fails to parse', () => {
    const out = run([hit()], [videoRow({ sheet_meta: 'not json{' })])
    expect(out.videos[0].sheetMeta).toBeNull()
  })

  // PR-feedback-6 regression: CE's vector_search join silently drops any
  // JSONB string field over 200 chars from the hit BEFORE this rule's own
  // `select` filtering runs — a real 10-tile sheet_meta blob is always well
  // over that. The old implementation read sheet_path/sheet_meta straight
  // off the hit, so it always got `sheet_meta: undefined` (dropped) even
  // though sheet_path (short) survived — exactly the live symptom reported
  // ("sheetUrl correctly populated but sheetMeta: null"). This reproduces
  // the exact live shape: a >200-char sheet_meta string, present on the
  // (untruncated) video row but ABSENT from the hit, same as production.
  test('sheetMeta survives a real, >200-char multi-tile blob even though the hit itself never carries it (live-bug repro)', () => {
    const bigMeta = {
      cols: 5,
      rows: 2,
      tileW: 320,
      tileH: 180,
      tiles: Array.from({ length: 10 }, (_, i) => ({ t: 16.950000000000003 + i * 33.9 })),
    }
    const bigMetaJson = JSON.stringify(bigMeta)
    expect(bigMetaJson.length).toBeGreaterThan(200) // sanity: this is the shape that gets dropped

    // The hit — exactly what vector_search actually returns in production:
    // no sheet_path/sheet_meta keys at all (dropped by the join, and no
    // longer even requested in `select` — see rule.yaml).
    const bareHit = hit()
    expect(bareHit).not.toHaveProperty('sheet_path')
    expect(bareHit).not.toHaveProperty('sheet_meta')

    const out = run(
      [bareHit],
      [videoRow({ sheet_path: '/api/uploads/sheets/v1/x.jpg', sheet_meta: bigMetaJson })],
    )
    expect(out.videos[0].sheetUrl).toBe('/api/uploads/sheets/v1/x.jpg')
    expect(out.videos[0].sheetMeta).toEqual(bigMeta)
  })

  test('looks up each video by its own id when multiple videos and video rows are present', () => {
    const out = run(
      [
        hit({ id: 'v1', chunkText: '[t=1s] a' }),
        hit({ id: 'v2', chunkText: '[t=1s] b', youtube_url: 'https://youtu.be/AAAAAAAAAAA' }),
      ],
      [
        videoRow({ id: 'v1', sheet_path: '/api/uploads/sheets/v1/x.jpg', sheet_meta: '{"tiles":[{"t":1}]}' }),
        videoRow({ id: 'v2', sheet_path: null, sheet_meta: null }),
      ],
    )
    const v1 = out.videos.find((v) => v.videoId === 'v1')
    const v2 = out.videos.find((v) => v.videoId === 'v2')
    expect(v1?.sheetUrl).toBe('/api/uploads/sheets/v1/x.jpg')
    expect(v2?.sheetUrl).toBeNull()
    expect(v2?.sheetMeta).toBeNull()
  })
})
