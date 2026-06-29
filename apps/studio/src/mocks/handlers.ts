import { http, HttpResponse, passthrough } from 'msw'
import { readMockAuth, writeMockAuth } from './mockAuthStore'
import { TRANSCRIBE_FIXTURE } from './transcribeFixture'

/**
 * Mock the Studio bucket-upload + transcription pipelines in dev so iterating on
 * the UI never hits real storage or the **paid** Replicate WhisperX call. Flip
 * to `false` to exercise the live pipelines (`/api/*` then bypasses to the Vite
 * proxy). Only active in dev — MSW isn't started in prod (see `main.tsx`).
 */
const MOCK_STUDIO = false

// A 1×1 PNG (mock stand-in for the rendered nano-banana thumbnail). Stored in
// objectStore so the /api/uploads/* serve route hands real bytes back to <img>.
const PLACEHOLDER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** A fake bucket host for the presigned PUT — intercepted below so no bytes leave. */
const MOCK_BUCKET = 'https://mock-bucket.studio.local'

/**
 * Bytes "uploaded" this session, so the serve route can hand them back the way
 * the real `file_serve` pipeline serves from the bucket — without this, the
 * `<img>`/`<video>` GETs to `/api/uploads/...` fall through to the live proxy and
 * 404 (the broken contact sheets + "Failed to fetch" SW errors). Only small
 * objects (contact sheets) are kept; the source video/audio are skipped to avoid
 * holding hundreds of MB in the worker. The Map lives in the service worker, so a
 * hard reload clears it — served objects 404 afterward and the UI re-attaches.
 */
const objectStore = new Map<string, { body: ArrayBuffer; type: string }>()
const MOCK_SERVE_MAX = 25_000_000
const lastSegment = (url: string) =>
  decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '')

/**
 * Project record store (story 11d). Mirrors the server's pipeline_records table:
 * keys are project ids; values are full records with `data` kept as a JSON string
 * (the format the client POSTs). GET /api/projects/get returns it parsed to mirror
 * the live server contract.
 */
const projectStore = new Map<string, Record<string, unknown>>()

/**
 * Async fire-and-poll job store (story 03f Part 0). The director/refiner start
 * endpoints now ENQUEUE a job and return a `jobId`; the FE polls `/api/studio/job`
 * until it's `done`. We stash the deterministic result at enqueue time and spin
 * `pending` → `running` → `done` across the first few polls so the FE poll loop
 * actually iterates before resolving (exactly like the real pipeline's postSteps).
 */
type MockJob = {
  kind: 'scenes' | 'refine' | 'transcribe' | 'blog'
  result: unknown
  polls: number
  // What the "pipeline" sent the model (story 03m) — fabricated here, but the
  // poll returns it exactly like the real rule, so the disclosure UI works offline.
  prompt?: string
  system?: string
}
const jobStore = new Map<string, MockJob>()
let jobCounter = 0
const enqueueJob = (
  kind: MockJob['kind'],
  result: unknown,
  prompt?: string,
  system?: string,
): string => {
  const jobId = `mock-job-${++jobCounter}`
  jobStore.set(jobId, { kind, result, polls: 0, prompt, system })
  return jobId
}

const studioHandlers = [
  // Presigned prepare (source + audio): hand back a fake bucket PUT URL (which we
  // also intercept) plus the storageKey/originalName the register step echoes.
  // The key is nested under projects/<projectId>/ to mirror the real bucket layout.
  http.post('/api/uploads/:kind/prepare', async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      filename?: string
      projectId?: string
    }
    const name = body.filename ?? 'clip'
    const kind = params.kind as string
    const pid = body.projectId ?? 'unknown-project'
    const storageKey = `projects/${pid}/${kind}/mock/${name}`
    return HttpResponse.json({
      uploadUrl: `${MOCK_BUCKET}/${storageKey}`,
      storageKey,
      originalName: name,
    })
  }),

  // The browser PUTs the bytes straight to the "bucket". Store under the full
  // path (everything after the mock-bucket host) so the nested key is retrievable
  // by the serve route below; skip large objects (source video/audio).
  http.put(`${MOCK_BUCKET}/*`, async ({ request }) => {
    const body = await request.arrayBuffer()
    if (body.byteLength <= MOCK_SERVE_MAX) {
      // Use the full pathname (minus leading slash) as the key so
      // `projects/<id>/<kind>/...` paths are stored and served correctly.
      const pathname = new URL(request.url).pathname.replace(/^\//, '')
      objectStore.set(pathname, {
        body,
        type: request.headers.get('content-type') ?? 'application/octet-stream',
      })
    }
    return new HttpResponse(null, { status: 200 })
  }),

  // Register (source + audio): return a serve url derived from the storageKey
  // in the request body, nesting it under projects/<projectId>/ to match the
  // real pipeline's serve path.
  http.post('/api/uploads/:kind/register', async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      originalName?: string
      storageKey?: string
      projectId?: string
    }
    // Prefer the echoed storageKey (sent by the real client flow); fall back to
    // reconstructing from projectId + kind + originalName.
    const kind = params.kind as string
    const name = body.originalName ?? 'clip'
    const pid = body.projectId ?? 'unknown-project'
    const keyPath = body.storageKey ?? `projects/${pid}/${kind}/mock/${name}`
    return HttpResponse.json({
      url: `/api/uploads/${keyPath}`,
    })
  }),

  // Sign a serve path for direct bucket reads (mirrors `/api/uploads/sign`,
  // which mints a presigned GCS download URL so big objects never stream through
  // the serve pipeline). The mock has no bucket — objects serve from the
  // in-memory store via the route below — so signing is identity.
  http.post('/api/uploads/sign', async ({ request }) => {
    const { url } = (await request.json().catch(() => ({}))) as { url?: string }
    if (!url) return new HttpResponse(null, { status: 400 })
    return HttpResponse.json({ url, expiresIn: 3600 })
  }),

  // Serve an uploaded object back (mirrors the real `file_serve` route). Returns
  // the stored bytes, or 404 if they weren't kept / the worker restarted.
  // The path after /api/uploads/ is used as the lookup key so nested paths like
  // projects/<id>/<kind>/... resolve correctly (exact key match first, then
  // lastSegment fallback for any pre-existing shallow objects).
  http.get('/api/uploads/*', ({ request }) => {
    const urlPath = new URL(request.url).pathname
    // Strip the leading /api/uploads/ prefix to get the storage key.
    const keyPath = urlPath.replace(/^\/api\/uploads\//, '')
    const obj = objectStore.get(keyPath) ?? objectStore.get(lastSegment(request.url))
    if (!obj) return new HttpResponse(null, { status: 404 })
    return new HttpResponse(obj.body, { status: 200, headers: { 'Content-Type': obj.type } })
  }),

  // Transcription: return the real captured WhisperX response (82 words with
  // word-level timestamps) so the editor has realistic data, free of charge.
  // Transcription is async now (story 10e): enqueue a job and return its id, the
  // same fire-and-poll shape as /api/scenes. The poll serves the fixture words.
  http.post('/api/transcribe', () => {
    const jobId = enqueueJob('transcribe', TRANSCRIBE_FIXTURE)
    return HttpResponse.json({ jobId, status: 'pending' })
  }),

  // Master director: enqueue a job and return its id (story 03f Part 0). The
  // canned synopsis + scenes (per-scene refinePrompt + cut spans, derived from the
  // posted `duration` so they fit any clip) are stashed as the job's `result` for
  // the poll endpoint to hand back. Mirrors the real enqueue shape: { jobId,
  // status }; the result blob mirrors { synopsis, scenes:[{ title, start, end,
  // transcript, refinePrompt, voicing, cuts }] }.
  http.post('/api/scenes', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { duration?: number; direction?: string }
    const jobId = enqueueJob(
      'scenes',
      mockDirector(body.duration ?? 0, body.direction ?? ''),
      `[mock] director prompt — duration: ${body.duration ?? 0}s · your direction: ${body.direction || '(none)'}`,
      '[mock] director system instruction — the standing rules the real pipeline sends Gemini.',
    )
    return HttpResponse.json({ jobId, status: 'pending' })
  }),

  // Per-scene refiner (story 03c): enqueue a job (story 03f Part 0). The canned
  // anchored segments + refined cuts — split into two runs around the kept
  // pause/cut — are stashed as the job's `result`. Mirrors
  // the enqueue shape { jobId, status }; the result blob mirrors { segments:
  // [{ text, start, end }], cuts: [{ start, end }] }.
  http.post('/api/refine-scene', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      start?: number
      end?: number
      wordTimings?: string
      audioUrl?: string
      // Creator steering (story 03l): the scene's own prompt + the global
      // director prompt (empty when the scene's include-checkbox is off).
      // Accepted so mock and real share the request shape; the deterministic
      // fixture ignores the content.
      direction?: string
      directorDirection?: string
      // Seam-aware context (story 03r): where this scene sits in the arc + the
      // tail of the previous scene's narration. Accepted so mock and real share
      // the request shape; the deterministic fixture ignores the content but
      // surfaces it in the prompt label below (prompt transparency, story 03m).
      sceneNumber?: number
      sceneCount?: number
      previousContext?: string
    }
    // Mirrors the real rule's schema (story 03k): the scene's cut audio is
    // required — refine without ears is the old cough-blind behavior.
    if (!body.audioUrl) {
      return HttpResponse.json({ error: 'audioUrl is required' }, { status: 400 })
    }
    const jobId = enqueueJob(
      'refine',
      mockRefiner(body),
      `[mock] refine prompt — scene ${body.sceneNumber ?? 1} of ${body.sceneCount ?? 1} [${body.start ?? 0}, ${body.end ?? 0}] · scene direction: ${body.direction || '(none)'} · director context: ${body.directorDirection || '(none)'} · previous scene ended with: ${body.previousContext || '(none — first scene)'}`,
      '[mock] refiner system instruction — the standing rules the real pipeline sends Gemini.',
    )
    return HttpResponse.json({ jobId, status: 'pending' })
  }),

  // Transcript search (story 08): deterministic keyword match over the posted
  // timedTranscript lines — each line containing a query word (≥3 chars)
  // becomes a hit spanning that line's 8s window. Real response shape:
  // { results: [{ start, end, snippet, reason }] }.
  http.post('/api/search-transcript', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      query?: string
      transcript?: string
      duration?: number
    }
    const terms = (body.query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 3)
    const results: { start: number; end: number; snippet: string; reason: string }[] = []
    for (const line of (body.transcript ?? '').split('\n')) {
      const m = /^\[(\d+):(\d{2})\]\s*(.*)$/.exec(line)
      if (!m) continue
      const startSec = Number(m[1]) * 60 + Number(m[2])
      const text = m[3]
      const term = terms.find((t) => text.toLowerCase().includes(t))
      if (!term) continue
      results.push({
        start: startSec,
        end: Math.min(startSec + 8, Math.max(body.duration ?? Infinity, startSec + 1)),
        snippet: text,
        reason: `mentions “${term}”`,
      })
    }
    return HttpResponse.json({ results: results.slice(0, 20) })
  }),

  // Export description (the finished-product page): a sync text call that writes a
  // recommended title + summary from the FINAL kept script (with the director's
  // synopsis as context). Deterministic stub derived from the inputs so it's
  // exercisable offline; the real rule is a Gemini text call (mirrors search).
  http.post('/api/describe', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { script?: string; synopsis?: string }
    const script = (body.script ?? '').trim()
    const synopsis = (body.synopsis ?? '').trim()
    const firstSentence = (script.split(/(?<=[.!?])\s/)[0] ?? script).replace(/[.!?]+$/, '').trim()
    const words = firstSentence.split(/\s+/).filter(Boolean).slice(0, 8).join(' ')
    const title = words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Untitled video'
    const summary = script
      ? `${synopsis ? synopsis + ' ' : ''}In short: ${firstSentence || 'the key points'}.`.trim()
      : 'No script to summarize yet.'
    return HttpResponse.json({ title, summary })
  }),

  // Blog post (issue #68): a sibling of the master director — enqueue a
  // `kind: 'blog'` job and return its id (story 03f fire-and-poll shape). The
  // deterministic Markdown (front-matter + an outline seeded from the script,
  // with a sparse inline `frame:<t>` token as raw text in this slice) is stashed
  // as the job's `result` for the poll endpoint. Mirrors the eventual live rule:
  // { jobId, status } on enqueue, { markdown } in the result blob.
  http.post('/api/blog', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { script?: string; direction?: string }
    const jobId = enqueueJob(
      'blog',
      mockBlog(body.script ?? '', body.direction ?? ''),
      `[mock] blog prompt — your direction: ${body.direction || '(none)'}`,
      '[mock] blog system instruction — the standing rules the real pipeline sends Gemini.',
    )
    return HttpResponse.json({ jobId, status: 'pending' })
  }),

  // Thumbnail — step 1: draft the nano-banana prompt (Export phase). The real
  // handler loads the `image-prompts` skill; the mock just echoes a plausible
  // multi-section prompt derived from the title/notes so the editable textarea has
  // realistic content. Same shape as the real pipeline: { prompt }.
  http.post('/api/thumbnail/draft', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      title?: string
      notes?: string
    }
    const title = (body.title ?? 'Your Video').trim()
    const notes = (body.notes ?? '').trim()
    const headline = title.split(/\s+/).slice(0, 5).join(' ').toUpperCase()
    const prompt = [
      'A 16:9 YouTube thumbnail, modern-dev-tool house style: dark navy #0B1226 flat',
      'background with a faint dot grid.',
      `Headline in heavy white sans-serif: "${headline}".`,
      'Small "WATCH ME CODE" pill top-left; a tilted code-editor mock on the right',
      'with a thin cyan #22D3EE outline.',
      notes ? `Creator notes: ${notes}.` : '',
      'Colors: navy #0B1226, off-white #F8FAFC, cyan #22D3EE. 3 colors max.',
      'Avoid: photorealistic humans, generic cloud icons, drop shadows, gradient mesh.',
    ].filter(Boolean).join(' ')
    return HttpResponse.json({ prompt })
  }),

  // Thumbnail — step 2: render the image with the (edited) prompt. The real
  // handler calls google/nano-banana and stores the result to the bucket; the
  // mock stashes a placeholder PNG in objectStore and returns its serve path, so
  // the same sign→<img> path works offline. Same shape as the real pipeline:
  // { imageUrl }.
  http.post('/api/thumbnail/render', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { projectId?: string }
    const pid = body.projectId ?? 'unknown-project'
    const keyPath = `projects/${pid}/youtube-thumbnail/mock-${Date.now()}.png`
    try {
      const binaryStr = atob(PLACEHOLDER_PNG_BASE64)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
      objectStore.set(keyPath, { body: bytes.buffer as ArrayBuffer, type: 'image/png' })
    } catch {
      // Non-fatal — serve route will 404 but the flow (persist + sign) still runs.
    }
    return HttpResponse.json({ imageUrl: `/api/uploads/${keyPath}` })
  }),

  // Poll a job (story 03f Part 0). Spins `pending` → `running` over the first two
  // polls, then resolves `done` with the stashed deterministic result — so the FE
  // poll loop iterates a couple of times before resolving, like the real pipeline.
  // Unknown ids resolve `error` (terminal) so the loop never hangs offline.
  http.get('/api/studio/job', ({ request }) => {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const job = jobStore.get(id)
    if (!job) {
      return HttpResponse.json({ status: 'error', kind: 'scenes', error: `Unknown job ${id}` })
    }
    job.polls += 1
    if (job.polls === 1) return HttpResponse.json({ status: 'pending', kind: job.kind })
    if (job.polls === 2) return HttpResponse.json({ status: 'running', kind: job.kind })
    return HttpResponse.json({
      status: 'done',
      kind: job.kind,
      result: job.result,
      prompt: job.prompt ?? null,
      system: job.system ?? null,
    })
  }),

  // Scene narration (story 03c): a short tone stands in for the persisted mp3 so
  // the diff-viewer audio players work offline. Returns a serve path nested under
  // projects/<projectId>/narration/ — mirrors the real pipeline's storage key
  // layout — with the WAV data stashed in objectStore so the GET route serves it.
  http.post('/api/voice/narrate', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      text?: string
      projectId?: string
    }
    const words = (body.text ?? '').trim().split(/\s+/).filter(Boolean).length
    const seconds = Math.max(1, Math.round(words / 2.5))
    const wavDataUrl = toneWavDataUrl(Math.min(seconds, 4))
    const pid = body.projectId ?? 'unknown-project'
    const filename = `narration-${Date.now()}.wav`
    const keyPath = `projects/${pid}/narration/mock/${filename}`
    // Decode the data-URL to raw bytes and stash in objectStore so the serve
    // route hands it back if anything GETs the url.
    try {
      const base64 = wavDataUrl.split(',')[1]
      if (base64) {
        const binaryStr = atob(base64)
        const bytes = new Uint8Array(binaryStr.length)
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
        objectStore.set(keyPath, { body: bytes.buffer as ArrayBuffer, type: 'audio/wav' })
      }
    } catch {
      // Non-fatal — serve route will 404 but the audioUrl data-URL still plays.
    }
    return HttpResponse.json({ audioUrl: `/api/uploads/${keyPath}` })
  }),

  // Voice clone (story 04): return a real MiniMax preset id as the stub — matches
  // the live clone-disabled pipeline, so the TTS preview below has a usable
  // voice and no $3 clone is ever spent.
  http.post('/api/voice/clone', () => HttpResponse.json({ voiceId: 'Friendly_Person' })),

  // Project CRUD (story 11d): in-memory projectStore mirrors the server's
  // pipeline_records table. `data` is stored as a JSON string (client sends it
  // that way); GET /api/projects/get returns it parsed to match the live contract.

  // Create a new project record: POST /api/projects body = ProjectRecord
  http.post('/api/projects', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof body.id === 'string') projectStore.set(body.id, body)
    return HttpResponse.json(body)
  }),

  // List all projects: GET /api/projects → array of metas (data stripped)
  http.get('/api/projects', () => {
    const metas = [...projectStore.values()].map((r) => {
      const { data, ...meta } = r
      void data // strip data, return meta only
      return meta
    })
    return HttpResponse.json(metas)
  }),

  // Get one full project record: GET /api/projects/get?id=<id>
  // Returns data parsed to an object — mirrors the live server contract.
  http.get('/api/projects/get', ({ request }) => {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const rec = projectStore.get(id)
    if (!rec) return HttpResponse.json({ id: null, data: null })
    return HttpResponse.json({
      ...rec,
      data: typeof rec.data === 'string' ? JSON.parse(rec.data) : rec.data,
    })
  }),

  // Save (upsert) a project record: POST /api/projects/save body = ProjectRecord
  http.post('/api/projects/save', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof body.id === 'string') projectStore.set(body.id, body)
    return HttpResponse.json(body)
  }),

  // Delete project assets (story 11c): wipe objectStore keys under the project
  // prefix and return { deleted, prefix }. Also removes the project record from
  // projectStore (story 11d) so the list stays consistent.
  http.post('/api/projects/delete', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { projectId?: string }
    const prefix = `projects/${body.projectId ?? ''}/`
    let deleted = 0
    for (const key of objectStore.keys()) {
      if (key.startsWith(prefix)) {
        objectStore.delete(key)
        deleted++
      }
    }
    if (body.projectId) projectStore.delete(body.projectId)
    return HttpResponse.json({ deleted, prefix })
  }),

  // Voice say (TTS preview): a short audible tone stands in for synthesized
  // narration, with a word-count-derived duration, so the preview plays offline
  // without a paid speech call.
  http.post('/api/voice/say', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { text?: string }
    const words = (body.text ?? '').trim().split(/\s+/).filter(Boolean).length
    const durationSeconds = Math.max(1, Math.round(words / 2.5))
    return HttpResponse.json({
      audioUrl: toneWavDataUrl(Math.min(durationSeconds, 4)),
      durationSeconds,
    })
  }),
]

/**
 * A deterministic canned refiner response for one scene, rebuilt FROM SCRATCH off
 * the posted per-word timings (story 03p — no more first-pass `draftText`). The
 * scene's words are split into two runs around a dropped beat: the first run keeps
 * the creator's own audio (`source: 'original'`, copying the words' exact
 * start/end so auto-adopt slices the real take), the second is re-voiced
 * (`source: 'revoice'`), and the gap between them is the refined cut. Falls back
 * to one original run when there are too few words to split.
 */
function mockRefiner(body: { start?: number; end?: number; wordTimings?: string }) {
  const start = Number.isFinite(body.start) ? (body.start as number) : 0
  const end =
    Number.isFinite(body.end) && (body.end as number) > start ? (body.end as number) : start + 1

  // Parse the `start end word` lines into timed words within the scene span.
  const words = (body.wordTimings ?? '')
    .split('\n')
    .map((l) => /^\s*([\d.]+)\s+([\d.]+)\s+(.+?)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ start: Number(m[1]), end: Number(m[2]), text: m[3] }))
    .filter(
      (w) =>
        Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= start && w.start < end,
    )

  if (words.length >= 4) {
    const mid = Math.floor(words.length / 2)
    const firstRun = words.slice(0, mid)
    const secondRun = words.slice(mid + 1) // drop one word as the removed beat
    const cutStart = firstRun[firstRun.length - 1].end
    const cutEnd = secondRun[0].start
    const segments = [
      {
        text: firstRun.map((w) => w.text).join(' '),
        start: firstRun[0].start,
        end: cutStart,
        source: 'original',
      },
      {
        text: secondRun.map((w) => w.text).join(' '),
        start: cutEnd,
        end: secondRun[secondRun.length - 1].end,
        source: 'revoice',
      },
    ]
    return { segments, cuts: cutEnd - cutStart > 0.05 ? [{ start: cutStart, end: cutEnd }] : [] }
  }

  // Too few words to split — one original run across the whole span.
  const text = words.map((w) => w.text).join(' ') || 'mock refined narration'
  return { segments: [{ text, start, end, source: 'original' }], cuts: [] }
}

/** A tiny mono 440 Hz tone encoded as a base64 WAV data URL — a stand-in clip. */
function toneWavDataUrl(seconds: number): string {
  const rate = 8000
  const n = Math.max(1, Math.floor(rate * seconds))
  const buffer = new ArrayBuffer(44 + n * 2)
  const view = new DataView(buffer)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + n * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    // gentle fade so it doesn't click; quiet amplitude
    const env = Math.min(1, i / 400, (n - i) / 400)
    const s = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.2 * env
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  const bytes = new Uint8Array(buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return `data:audio/wav;base64,${btoa(bin)}`
}

/**
 * A deterministic canned blog post (issue #68): YAML front-matter (title +
 * description) followed by a short prose outline seeded from the final script,
 * plus one sparse inline `frame:<t>` image token (raw text in this slice). The
 * title is the script's first few words; the body folds in the creator's
 * direction so the mock is exercisable offline and visibly reflects its inputs.
 * Same `{ markdown }` shape the live rule returns, coerced through `toBlog`.
 */
function mockBlog(script: string, direction: string): { markdown: string } {
  const clean = script.trim()
  if (!clean) return { markdown: '' }
  const firstSentence = (clean.split(/(?<=[.!?])\s/)[0] ?? clean).replace(/[.!?]+$/, '').trim()
  const titleWords = firstSentence.split(/\s+/).filter(Boolean).slice(0, 8).join(' ')
  const title = titleWords ? titleWords.charAt(0).toUpperCase() + titleWords.slice(1) : 'Untitled post'
  const description = `A written companion to the video${direction ? ` — ${direction}` : ''}.`
  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const lead = paragraphs[0] ?? clean
  const rest = paragraphs.slice(1)
  const body = [
    '---',
    `title: ${title}`,
    `description: ${description}`,
    '---',
    '',
    `# ${title}`,
    '',
    lead,
    '',
    'frame:1.5',
    '',
    ...(rest.length ? ['## In depth', '', ...rest.flatMap((p) => [p, ''])] : []),
    direction ? `> Written with your direction: ${direction}` : '',
  ]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === '')) // collapse doubled blanks
    .join('\n')
    .trim()
  return { markdown: body }
}

/** A deterministic canned director response sized to the clip's duration. */
function mockDirector(duration: number, direction: string) {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 600
  const count = Math.max(1, Math.round(total / 210)) // ~3.5 min scenes
  // "keep my voice / cut the ums" direction → an all-original plan (story 03j).
  const keepOriginal = /\b(um+s?|uh+s?|ah+s?|filler|keep my (own )?voice|original audio)\b/i.test(direction)
  const VOICINGS = ['revoice', 'original', 'mixed'] as const
  const each = total / count
  const beats = [
    { title: 'Cold open — the problem', draft: 'Here is the problem we kept running into, and why the usual fix falls apart at scale.' },
    { title: 'The turn — what changed', draft: 'So we tried something different. The key insight was to let the pipeline do the rewriting up front.' },
    { title: 'The demo', draft: 'Let me show you. You upload one clip, and it preps everything — transcript, scenes, your cloned voice.' },
    { title: 'How it works', draft: 'Under the hood it is a chain of small steps, each one handed off to the next, no server code.' },
    { title: 'Where it goes next', draft: 'Next we tighten each scene, line the footage up to the voice, and ship the cut.' },
  ]
  const scenes = Array.from({ length: count }, (_, i) => {
    const start = i * each
    const end = i === count - 1 ? total : (i + 1) * each
    const beat = beats[i % beats.length]
    // Drop a chunk of dead air in the middle third of each scene.
    const cutStart = start + each * 0.45
    const cutEnd = start + each * 0.62
    return {
      title: beat.title,
      start,
      end,
      voicing: keepOriginal ? 'original' : VOICINGS[i % VOICINGS.length],
      transcript: `(${Math.round(end - start)}s of original footage for this scene)`,
      refinePrompt: `Tighten this beat${direction ? `, ${direction}` : ''}; drop the dead air in the middle, keep the on-screen action visible.`,
      cuts: [{ start: cutStart, end: cutEnd }],
    }
  })
  return {
    synopsis:
      'A builder turns one long, rambly screen recording into a tight, scene-by-scene short — the AI cuts the dead weight, groups the rest into chapters, and re-voices it in the maker’s own cloned voice.',
    scenes,
  }
}

export const handlers = [
  http.get('/_bffless/auth/session', () => {
    const state = readMockAuth()
    if (!state.enabled) return passthrough()
    if (!state.authenticated) {
      return HttpResponse.json({ authenticated: false, user: null })
    }
    return HttpResponse.json({ authenticated: true, user: state.user })
  }),

  http.post('/_bffless/auth/refresh', () => {
    const state = readMockAuth()
    if (!state.enabled) return passthrough()
    return new HttpResponse(null, { status: state.authenticated ? 200 : 401 })
  }),

  http.post('/_bffless/auth/logout', () => {
    const state = readMockAuth()
    if (!state.enabled) return passthrough()
    writeMockAuth({ ...state, authenticated: false })
    return new HttpResponse(null, { status: 204 })
  }),

  // Studio upload + transcription mocks (dev only, paid-call savings). The real
  // pipelines are wired (stories 01/01b/02); these return the same shapes so the
  // FE is unchanged. Set `MOCK_STUDIO = false` above to use the live endpoints.
  ...(MOCK_STUDIO ? studioHandlers : []),
]
