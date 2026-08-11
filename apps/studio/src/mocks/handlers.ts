import { http, HttpResponse, passthrough } from 'msw'
import { readMockAuth, writeMockAuth } from './mockAuthStore'
import { TRANSCRIBE_FIXTURE } from './transcribeFixture'

/**
 * Mock the Studio bucket-upload + transcription pipelines in dev so iterating on
 * the UI never hits real storage or the **paid** Replicate WhisperX call. Set
 * `VITE_MOCK_STUDIO=true` to enable; default off exercises the live pipelines
 * (`/api/*` then bypasses to the Vite proxy). Only active in dev — MSW isn't
 * started in prod (see `main.tsx`).
 */
const MOCK_STUDIO = import.meta.env.VITE_MOCK_STUDIO === 'true'

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
  // in-memory store via the route below — so signing is identity UNLESS the
  // caller passes `filename` (the `signAttachment` query), in which case it
  // returns a bucket-like cross-origin URL carrying a Content-Disposition so a
  // component test can assert both the cross-origin-ness and the download name.
  http.post('/api/uploads/sign', async ({ request }) => {
    const { url, filename } = (await request.json().catch(() => ({}))) as {
      url?: string
      filename?: string
    }
    if (!url) return new HttpResponse(null, { status: 400 })
    if (filename) {
      const signed = new URL(`https://bucket.example.com${url}`)
      signed.searchParams.set('X-Goog-Signature', 'mock')
      signed.searchParams.set(
        'response-content-disposition',
        `attachment; filename="${filename}"`,
      )
      return HttpResponse.json({ url: signed.toString(), expiresIn: 3600 })
    }
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
  // canned synopsis + scenes (per-scene cutting brief + cut spans, derived from
  // the posted `duration` so they fit any clip) are stashed as the job's `result`
  // for the poll endpoint to hand back. Mirrors the real enqueue shape: { jobId,
  // status }; the result blob mirrors the 13f contract { synopsis, scenes:
  // [{ title, start, end, brief, cuts }] } — scenes tile the recording; no
  // draftText, no transcript echo.
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

  // Per-scene refiner (story 03c, 13f contract): enqueue a job (story 03f
  // Part 0). The canned refined cuts — snapped into the posted measured dead
  // space — are stashed as the job's `result`. Mirrors the enqueue shape
  // { jobId, status }; the result blob mirrors the 13f contract:
  // { cuts: [{ start, end }] }, nothing else.
  http.post('/api/refine-scene', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      start?: number
      end?: number
      wordTimings?: string
      audioUrl?: string
      // The director's cutting brief + the measured dead-space lines (story
      // 13f). The fixture cuts the longest posted silence; the brief is only
      // surfaced in the prompt label (prompt transparency, story 03m).
      brief?: string
      deadSpace?: string
      // Creator steering (story 03l): the scene's own prompt + the global
      // director prompt (empty when the scene's include-checkbox is off).
      // Accepted so mock and real share the request shape; the deterministic
      // fixture ignores the content.
      direction?: string
      directorDirection?: string
      // Seam-aware context (story 03r): where this scene sits in the arc + the
      // tail of the previous scene's kept speech. Accepted so mock and real
      // share the request shape; the deterministic fixture ignores the content
      // but surfaces it in the prompt label below (story 03m).
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
      `[mock] refine prompt — scene ${body.sceneNumber ?? 1} of ${body.sceneCount ?? 1} [${body.start ?? 0}, ${body.end ?? 0}] · brief: ${body.brief || '(none)'} · dead space: ${body.deadSpace ? `${body.deadSpace.split('\n').length} span(s)` : '(none)'} · scene direction: ${body.direction || '(none)'} · director context: ${body.directorDirection || '(none)'} · previous scene ended with: ${body.previousContext || '(none — first scene)'}`,
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
  // with a sparse inline `frame:<t>` token the FE then captures + uploads as a
  // blog image, issue #70) is stashed as the job's `result` for the poll
  // endpoint. Mirrors the eventual live rule:
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

]

/**
 * A deterministic canned refiner response for one scene — the 13f contract:
 * `{ cuts }` only, no narration, no segments. Prefers the posted MEASURED dead
 * space (story 13c: `start end` lines, the same shape the real prompt gets) and
 * returns the longest silence in the scene as the one refined cut — the
 * snap-into-silence behavior the real prompt asks for. Falls back to the
 * biggest gap between consecutive posted word timings (story 03p) when no dead
 * space was measured; no cuts when there's too little to go on.
 */
function mockRefiner(body: { start?: number; end?: number; wordTimings?: string; deadSpace?: string }) {
  const start = Number.isFinite(body.start) ? (body.start as number) : 0
  const end =
    Number.isFinite(body.end) && (body.end as number) > start ? (body.end as number) : start + 1

  // Preferred: the longest measured dead-space span inside the scene.
  const dead = (body.deadSpace ?? '')
    .split('\n')
    .map((l) => /^\s*([\d.]+)\s+([\d.]+)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ start: Number(m[1]), end: Number(m[2]) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= start && s.end <= end)
  if (dead.length) {
    const longest = dead.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a))
    return { cuts: longest.end - longest.start > 0.05 ? [longest] : [] }
  }

  // Fallback: the biggest gap between consecutive words in the scene span.
  const words = (body.wordTimings ?? '')
    .split('\n')
    .map((l) => /^\s*([\d.]+)\s+([\d.]+)\s+(.+?)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ start: Number(m[1]), end: Number(m[2]), text: m[3] }))
    .filter(
      (w) =>
        Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= start && w.start < end,
    )

  if (words.length < 4) return { cuts: [] }

  let cutStart = words[0].end
  let cutEnd = words[1].start
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end
    if (gap > cutEnd - cutStart) {
      cutStart = words[i - 1].end
      cutEnd = words[i].start
    }
  }
  return { cuts: cutEnd - cutStart > 0.05 ? [{ start: cutStart, end: cutEnd }] : [] }
}


/**
 * A deterministic canned blog post (issue #68): YAML front-matter (title +
 * description) followed by a short prose outline seeded from the final script,
 * plus one sparse inline `frame:<t>` image token (the FE captures + uploads it,
 * issue #70). The
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
    '![A quick look at the project](frame:1.5)',
    '',
    ...(rest.length ? ['## In depth', '', ...rest.flatMap((p) => [p, ''])] : []),
    direction ? `> Written with your direction: ${direction}` : '',
  ]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === '')) // collapse doubled blanks
    .join('\n')
    .trim()
  return { markdown: body }
}

/** A deterministic canned director response sized to the clip's duration —
 *  the 13f cut-first contract: scenes tile `[0, duration]` end-to-end, each
 *  `{ title, start, end, brief, cuts }`. Coerced by the app through the same
 *  `toScenes` the real pipeline's response goes through. */
function mockDirector(duration: number, direction: string) {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 600
  const count = Math.max(1, Math.round(total / 210)) // ~3.5 min scenes
  const each = total / count
  const titles = [
    'Cold open — the problem',
    'The turn — what changed',
    'The demo',
    'How it works',
    'Where it goes next',
  ]
  const scenes = Array.from({ length: count }, (_, i) => {
    const start = i * each
    const end = i === count - 1 ? total : (i + 1) * each
    // Drop a chunk of dead air in the middle third of each scene.
    const cutStart = start + each * 0.45
    const cutEnd = start + each * 0.62
    return {
      title: titles[i % titles.length],
      start,
      end,
      brief: `Tighten this beat${direction ? `, ${direction}` : ''}; drop the dead air in the middle, keep the on-screen action visible.`,
      cuts: [{ start: cutStart, end: cutEnd }],
    }
  })
  return {
    synopsis:
      'A builder turns one long, rambly screen recording into a tight, scene-by-scene short — the AI proposes the cuts, groups the rest into chapters, and the maker’s own voice carries the whole thing.',
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

  // The refresh Studio actually uses on a primary-domain subdomain: SuperTokens'
  // own route, reached through the `/api/auth/*` proxy rule. `/_bffless/auth/refresh`
  // below is the cross-origin-custom-domain fallback and is never hit in practice here.
  http.post('/api/auth/session/refresh', () => {
    const state = readMockAuth()
    if (!state.enabled) return passthrough()
    return new HttpResponse(null, { status: state.authenticated ? 200 : 401 })
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
  // FE is unchanged. Set `VITE_MOCK_STUDIO=true` to use the mocks (default off,
  // which hits the live endpoints).
  ...(MOCK_STUDIO ? studioHandlers : []),
]
