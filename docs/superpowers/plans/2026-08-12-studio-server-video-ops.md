# Studio Server-Side Video Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Studio's four video ops (audio extract, per-scene cut, per-scene assemble, final stitch) to CE's new `ffmpeg_handler` server ops when the instance is capable, keeping the wasm/WebAudio path as an untouched fallback — so headless CI Build drops from 45+ wasm-minutes to native seconds with zero runner changes.

**Architecture:** Four new authored proxy rules (`/api/video/capabilities` sync probe + three fire-and-poll enqueue rules reusing the existing `studio_jobs` table and the kind-agnostic `GET /api/studio/job` poll). Client-side, a once-per-session backend resolver (modeled on `resolveCoreChoice`) branches at exactly the seams the research pinned: `sliceScene`, the assemble/stitch call sites above `assembleScene.ts`, and the two `extractAudio` call sites. Server ops move bytes bucket→bucket; the browser never downloads the source.

**Tech Stack:** Authored BFFless rules (YAML + `.fn.js`), React/Redux (RTK Query), MSW mocks, Vitest.

**Specs/contracts:**
- Part 2 of `repos/ce` spec `docs/superpowers/specs/2026-08-12-ce-ffmpeg-pipeline-handler-design.md`
- The CE plan's "Contract exported to the Studio plan" (restated below) — shipped and live in **CE v0.4.25** on j5s.dev

## Global Constraints

- **Swap-don't-rewrite:** every server op returns the same contract the wasm path produces — an `/api/uploads/...` serve URL landing in the same state fields (`Scene.clipUrl`, `clipAudioUrl`, `assembledUrl`, `finalCutUrl`, `audioUrl`). Scene state, Auto Build, and the UI keep their shape.
- **Wasm/WebAudio fallback stays fully intact and untouched** (spec success criterion 3: a CE without ffmpeg runs Studio exactly as today). No changes to `src/lib/export/ffmpeg.ts`, `slice.ts`, `assemble.ts`, `audio.ts` internals, the core-mt patch, or COOP/COEP config.
- **Mock-first parity (CLAUDE.md non-negotiable):** every new `/api/*` endpoint gets an MSW mock returning the same shape, coerced through one pure `toX()`.
- **Scheduler unchanged:** `STEP_LANE`/`nextActions` keep the ffmpeg lane at capacity 1 — it maps 1:1 onto the server's concurrency-1 queue (spec locked decision). Do NOT add lanes or capacities.
- **Headless runner: zero changes** — the same clicks get fast.
- CE handler contract (from the CE plan, v0.4.25): `ffmpeg_handler` config `{ operation: 'probe'|'extract_audio'|'slice'|'concat', input?, inputs?, spans?, output?, audioOutput?, audioFades? }`. Inputs accept `/api/uploads/<rel>` serve paths directly; outputs are uploads-relative; handler returns `{ storage_path: '<owner>/<repo>/uploads/<rel>', content_type, size, ... }` (slice adds `duration` + optional `audio`; concat adds `reencoded`; probe-no-input returns `{ server, ops, version }` and NEVER fails). `spans` may be a real array (JSON bodies) — values already numeric. Error codes incl. `FFMPEG_UNAVAILABLE`/`FFMPEG_BUSY` exist but postSteps failures surface to job rows only via the check-fn pattern (generic message — same limitation as transcribe).
- **Rules conventions** (from the live set): authored YAML under `apps/studio/.bffless/proxy-rules/studio/rules/`, path derived from directory (`api/video/slice/post/rule.yaml` → `POST /api/video/slice`), `handler:` + `code: ./x.fn.js` sugar, `$schema:studio_jobs` by name, **new rules take `order:` 56, 57, 58, 59** (55 is the current max across both sets). `.fn.js` sandbox forbids `require`/`fetch`/`Buffer`/`crypto`; `uuid()` IS available — but only inside handler-config template expressions (`{{uuid()}}`), not in fn.js.
- **Reuse, don't add:** the `studio_jobs` schema is NOT modified (live schemas never mutate on push — output URLs ride inside the `result` json blob), and the existing `GET /api/studio/job` poll rule is reused unchanged (it's kind-agnostic). New job kinds: `'video-extract'`, `'video-slice'`, `'video-concat'`.
- **No validators on the new rules** (matches the whole studio set — auth deferred to story 07), **no secrets** needed.
- `bffless-app.json` `requires.ceMin` stays `"0.4.19"` (spec locked: the app runs everywhere; server ops are a capability, not a requirement). Prose docs note v0.4.25 unlocks them.
- Storage path mapping (must hold everywhere): serve URL `/api/uploads/<key>` ⇔ storage path `<owner>/<repo>/uploads/<key>`; server outputs write under `projects/<projectId>/<kind>/server/...` so every existing read path (`isUploadServePath` → sign → fetch) works unchanged. Server outputs do NOT get `studio_source` rows (register is an upload-flow concern; nothing reads rows for clips/exports) — accepted v1 difference, noted in docs.
- Verification per task: `pnpm --filter studio test:run` (focused via `pnpm --filter studio exec vitest run <file>`), `pnpm --filter studio build` (includes tsc), `pnpm --filter studio lint` must stay clean on touched files; rules tasks also run `npx bffless rules validate` and `npx bffless rules test` from the repo root.
- Commit after every task on branch `studio/server-video-ops` (worktree `repos/apps/.claude/worktrees/studio-server-video`). One PR; per repo convention rules go live on merge to main (preview PRs are dry-run only).

## Interfaces this plan pins (consumed across tasks)

```ts
// studioApi.ts additions (Task 1)
export type VideoJobKind = 'video-extract' | 'video-slice' | 'video-concat'
export type VideoResult = { url: string; audioUrl?: string | null; duration?: number | null }
export function toVideoResult(raw: unknown): VideoResult   // throws on missing/non-string url
// mutations: videoExtractStart({ sourceUrl, projectId }), videoSliceStart({ sourceUrl, spans, wantAudio, audioFades, projectId }), videoConcatStart({ parts, projectId }) — all → StartJobResponse

// videoBackend.ts (Task 2)
export type VideoBackend = 'server' | 'wasm'
export function resolveVideoBackend(search: string, stored: string | null, probe: { server: boolean } | null): VideoBackend
export function getVideoBackend(): Promise<VideoBackend>   // once-per-session promise memo; never rejects (probe failure → 'wasm')
export function resetVideoBackendForTests(): void

// useScenePipeline (Tasks 6-8)
pollJob(jobId, opts?: { timeoutMs?: number })               // default unchanged (5 min); video ops pass VIDEO_POLL_TIMEOUT_MS = 35 * 60 * 1000
assembleSceneRemote(sceneId: string): Promise<void>         // enqueue+poll+patchScene({assembledUrl,status:'built'}); throws on failure (assemble regime)
stitchFinalCutRemote(): Promise<void>                       // enqueue+poll+setFinalCutUrl; throws

// Job result blobs (written by rules, read by toVideoResult):
// video-extract → { url }
// video-slice   → { url, audioUrl?, duration }
// video-concat  → { url }
```

## File Structure

New:
- `apps/studio/src/lib/videoBackend.ts` + `videoBackend.test.ts`
- `apps/studio/.bffless/proxy-rules/studio/rules/api/video/capabilities/get.rule.yaml`
- `apps/studio/.bffless/proxy-rules/studio/rules/api/video/extract-audio/post/{rule.yaml,prep.fn.js,check.fn.js,check.fn.test.yaml}`
- `apps/studio/.bffless/proxy-rules/studio/rules/api/video/slice/post/{rule.yaml,prep.fn.js,check.fn.js,check.fn.test.yaml}`
- `apps/studio/.bffless/proxy-rules/studio/rules/api/video/concat/post/{rule.yaml,prep.fn.js,check.fn.js,check.fn.test.yaml}`

Modified:
- `apps/studio/src/store/studioApi.ts` (kind/result unions ~:50-60, three mutations after `transcribeStart` ~:100)
- `apps/studio/src/mocks/handlers.ts` (MockJob kind ~:52, `/api/video/*` handlers, capabilities)
- `apps/studio/src/components/Studio/useScenePipeline.ts` (pollJob param ~:409; sliceScene ~:1300; extract seams ~:849/:1046; new remote fns)
- `apps/studio/src/components/Studio/useAutoBuild.ts` (assemble ~:268-276, stitch ~:198-218 branches)
- `apps/studio/src/components/Studio/SceneAssembleBar.tsx` (~:82-94), `FinalCutBar.tsx` (~:68-95)
- Docs: `apps/studio/CLAUDE.md`, `apps/studio/bffless/README.md`, `docs/bffless-backend-inventory.md` (counts 40→44 + endpoint table), `apps/studio/stories/14-headless-run.md` follow-up note

---

### Task 1: studioApi types, coercer, and the three enqueue mutations

**Files:**
- Modify: `apps/studio/src/store/studioApi.ts`
- Test: `apps/studio/src/store/studioApi.videoResult.test.ts` (new; colocated `.test.ts` per repo convention)

**Interfaces:**
- Produces: everything in the "Interfaces this plan pins" studioApi block. `StudioJob['kind']` union (currently `'scenes' | 'refine' | 'transcribe' | 'blog'` at ~:52) gains the three video kinds; `StudioJob['result']` union gains `VideoResult`.
- Consumes: existing `StartJobResponse` (:42), `builder.mutation` pattern of `transcribeStart` (:94-100).

- [ ] **Step 1: Write the failing test**

```ts
// apps/studio/src/store/studioApi.videoResult.test.ts
import { describe, expect, it } from 'vitest'
import { toVideoResult } from './studioApi'

/** Mock and real /api/video job results must coerce through one pure toX() (CLAUDE.md). */
describe('toVideoResult', () => {
  it('passes through a full slice result', () => {
    expect(
      toVideoResult({ url: '/api/uploads/projects/p1/scene-clip/server/a.mp4', audioUrl: '/api/uploads/x.wav', duration: 12.5 }),
    ).toEqual({ url: '/api/uploads/projects/p1/scene-clip/server/a.mp4', audioUrl: '/api/uploads/x.wav', duration: 12.5 })
  })

  it('normalizes missing optionals to null', () => {
    expect(toVideoResult({ url: '/api/uploads/y.mp4' })).toEqual({ url: '/api/uploads/y.mp4', audioUrl: null, duration: null })
  })

  it('throws on a missing or non-string url (a job that "succeeded" without output is a failure)', () => {
    expect(() => toVideoResult({})).toThrow()
    expect(() => toVideoResult(null)).toThrow()
    expect(() => toVideoResult({ url: 42 })).toThrow()
  })

  it('tolerates a JSON-string result blob (data_query may return the row json as a string)', () => {
    expect(toVideoResult(JSON.stringify({ url: '/api/uploads/z.mp4' }))).toEqual({ url: '/api/uploads/z.mp4', audioUrl: null, duration: null })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter studio exec vitest run src/store/studioApi.videoResult.test.ts`
Expected: FAIL — `toVideoResult` not exported.

- [ ] **Step 3: Implement**

In `studioApi.ts`:
- Widen the unions (find the exact lines; research pinned ~:50-60):

```ts
export type VideoJobKind = 'video-extract' | 'video-slice' | 'video-concat'
// kind: 'scenes' | 'refine' | 'transcribe' | 'blog' | VideoJobKind
// result?: ScenesResult | RefineSceneResult | TranscribeResponse | BlogResult | VideoResult | null

export type VideoResult = { url: string; audioUrl?: string | null; duration?: number | null }

/** One pure coercer for both MSW and real /api/video job results (mock-parity rule). */
export function toVideoResult(raw: unknown): VideoResult {
  const obj = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
  const r = (obj ?? {}) as { url?: unknown; audioUrl?: unknown; duration?: unknown }
  if (typeof r.url !== 'string' || !r.url) throw new Error('Video job finished without an output URL.')
  return {
    url: r.url,
    audioUrl: typeof r.audioUrl === 'string' && r.audioUrl ? r.audioUrl : null,
    duration: typeof r.duration === 'number' && Number.isFinite(r.duration) ? r.duration : null,
  }
}
```

- Add the three mutations directly after `transcribeStart`, same shape:

```ts
videoExtractStart: builder.mutation<StartJobResponse, { sourceUrl: string; projectId: string }>({
  query: (body) => ({ url: 'api/video/extract-audio', method: 'POST', body }),
}),
videoSliceStart: builder.mutation<
  StartJobResponse,
  { sourceUrl: string; spans: { start: number; end: number }[]; wantAudio: boolean; audioFades: boolean; projectId: string }
>({
  query: (body) => ({ url: 'api/video/slice', method: 'POST', body }),
}),
videoConcatStart: builder.mutation<StartJobResponse, { parts: string[]; projectId: string }>({
  query: (body) => ({ url: 'api/video/concat', method: 'POST', body }),
}),
```

Export the new hooks in the file's hook export block (match how `useTranscribeStartMutation` is exported).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter studio exec vitest run src/store/studioApi.videoResult.test.ts` then `pnpm --filter studio build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/studio/src/store
git commit -m "feat(studio): video job kinds, result coercer, and enqueue mutations"
```

---

### Task 2: the backend resolver (`videoBackend.ts`)

Once-per-session probe of `GET /api/video/capabilities`, override chain modeled EXACTLY on the two precedents: `resolveCoreChoice` (`src/lib/export/ffmpeg.ts:69-91`, pure + URL override persisted to localStorage) and `getFFmpeg`'s promise memo (`ffmpeg.ts:54,106-142`, cache the promise not the result).

**Files:**
- Create: `apps/studio/src/lib/videoBackend.ts`
- Test: `apps/studio/src/lib/videoBackend.test.ts`

**Interfaces:**
- Produces: `resolveVideoBackend`, `getVideoBackend`, `resetVideoBackendForTests` per the pinned block.
- Consumes: `fetchWithReauth` from `src/lib/auth.ts` (same import the upload helper uses — check `src/lib/upload.ts`'s import line and match it).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/studio/src/lib/videoBackend.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveVideoBackend, getVideoBackend, resetVideoBackendForTests } from './videoBackend'

describe('resolveVideoBackend (pure)', () => {
  it('a ?videoBackend override beats everything', () => {
    expect(resolveVideoBackend('?videoBackend=wasm', null, { server: true })).toBe('wasm')
    expect(resolveVideoBackend('?videoBackend=server', null, { server: false })).toBe('server')
  })
  it('a stored choice beats the probe', () => {
    expect(resolveVideoBackend('', 'wasm', { server: true })).toBe('wasm')
  })
  it('defaults by probe capability', () => {
    expect(resolveVideoBackend('', null, { server: true })).toBe('server')
    expect(resolveVideoBackend('', null, { server: false })).toBe('wasm')
    expect(resolveVideoBackend('', null, null)).toBe('wasm')
  })
  it('garbage values fall through to the probe default', () => {
    expect(resolveVideoBackend('?videoBackend=nope', 'nope', { server: true })).toBe('server')
  })
})

describe('getVideoBackend (session memo)', () => {
  afterEach(() => {
    resetVideoBackendForTests()
    vi.unstubAllGlobals()
  })

  it('probes once and memoizes — concurrent callers share one fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ server: true, ops: ['probe', 'slice'], version: 'ffmpeg 7' })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const [a, b] = await Promise.all([getVideoBackend(), getVideoBackend()])
    expect(a).toBe('server')
    expect(b).toBe('server')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never rejects: probe failure resolves wasm (spec: older CE runs exactly as today)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(getVideoBackend()).resolves.toBe('wasm')
  })

  it('non-JSON / 404 responses resolve wasm', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<!doctype html>', { status: 404 })))
    await expect(getVideoBackend()).resolves.toBe('wasm')
  })
})
```

Note: `getVideoBackend` should use `fetchWithReauth`, which ultimately calls `fetch` — if stubbing global fetch doesn't reach it (check `auth.ts`), inject the fetcher: `getVideoBackend(fetcher = fetchWithReauth)` and pass a mock in tests. Prefer whichever `auth.ts`'s own tests do; disclose the choice.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter studio exec vitest run src/lib/videoBackend.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// apps/studio/src/lib/videoBackend.ts
/**
 * Which backend runs video ops this session: CE's server-side ffmpeg_handler
 * ('server') or the in-browser wasm/WebAudio path ('wasm').
 *
 * Mirrors resolveCoreChoice (export/ffmpeg.ts): a ?videoBackend=server|wasm URL
 * override wins and is persisted to localStorage; otherwise a stored choice;
 * otherwise probe GET /api/video/capabilities once per session. The probe can
 * never break the app — any failure (older CE, no rule, network) resolves
 * 'wasm', which is exactly today's behavior.
 */
import { fetchWithReauth } from './auth'

export type VideoBackend = 'server' | 'wasm'

const STORAGE_KEY = 'videoBackend'

function asBackend(v: unknown): VideoBackend | null {
  return v === 'server' || v === 'wasm' ? v : null
}

export function resolveVideoBackend(
  search: string,
  stored: string | null,
  probe: { server: boolean } | null,
): VideoBackend {
  const override = asBackend(new URLSearchParams(search).get('videoBackend'))
  if (override) return override
  const persisted = asBackend(stored)
  if (persisted) return persisted
  return probe?.server ? 'server' : 'wasm'
}

// Cache the PROMISE, not the result (getFFmpeg pattern) — StrictMode double-mounts
// and concurrent op starts must share one probe.
let memo: Promise<VideoBackend> | null = null

export function getVideoBackend(): Promise<VideoBackend> {
  if (memo) return memo
  memo = (async () => {
    let search = ''
    let stored: string | null = null
    try {
      search = window.location.search
      const override = asBackend(new URLSearchParams(search).get('videoBackend'))
      if (override) localStorage.setItem(STORAGE_KEY, override)
      stored = localStorage.getItem(STORAGE_KEY)
    } catch {
      /* non-browser context */
    }
    // Overrides and stored choices skip the network entirely.
    const preProbe = resolveVideoBackend(search, stored, null)
    if (preProbe === 'server' || asBackend(stored) || asBackend(new URLSearchParams(search).get('videoBackend'))) {
      if (preProbe === 'server') return 'server'
      if (asBackend(stored) === 'wasm' || asBackend(new URLSearchParams(search).get('videoBackend')) === 'wasm') return 'wasm'
    }
    try {
      const res = await fetchWithReauth('/api/video/capabilities')
      if (!res.ok) return 'wasm'
      const caps = (await res.json()) as { server?: boolean }
      return resolveVideoBackend(search, stored, { server: caps.server === true })
    } catch {
      return 'wasm'
    }
  })()
  return memo
}

export function resetVideoBackendForTests(): void {
  memo = null
}
```

Simplify the pre-probe short-circuit while implementing (the intent: override/stored answers skip the fetch; only the "no opinion" case probes) — the tests pin the observable behavior. Keep the logic readable; if `resolveVideoBackend(search, stored, null)` returning `'wasm'` can't distinguish "explicitly wasm" from "no opinion", pass the pieces separately (e.g. compute `override`/`persisted` first, probe only when both are null).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter studio exec vitest run src/lib/videoBackend.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/studio/src/lib
git commit -m "feat(studio): once-per-session video backend resolver with ?videoBackend override"
```

---

### Task 3: MSW mocks for `/api/video/*`

Mirror the transcribe pair exactly (`src/mocks/handlers.ts:173-176` enqueue, `:356-372` poll — the poll handler needs no change beyond the kind type). Mocks must write a fake output object into `objectStore` so the returned serve path actually serves (the "returned storage path actually serves" property the research called out).

**Files:**
- Modify: `apps/studio/src/mocks/handlers.ts`
- Test: extend `apps/studio/src/mocks/handlers.test.ts` if it asserts handler counts/paths; otherwise verification is Task 6-8's mock-driven flows + `pnpm --filter studio test:run`

**Interfaces:**
- Consumes: `enqueueJob(kind, result)` (:62-71), `objectStore` + `MOCK_BUCKET` key conventions (:31-34, :77-91), `MockJob` type (:51-52).
- Produces: `POST /api/video/extract-audio` → `enqueueJob('video-extract', { url })`; `POST /api/video/slice` → `enqueueJob('video-slice', { url, audioUrl?, duration })`; `POST /api/video/concat` → `enqueueJob('video-concat', { url })`; `GET /api/video/capabilities` → `{ server: true, ops: ['probe','extract_audio','slice','concat'], version: 'ffmpeg 7.0-mock' }`.

- [ ] **Step 1: Implement** (mock changes are verified by the consuming flows; follow the file's local style)

- Widen `MockJob['kind']` (:52) with the three video kinds.
- Add handlers inside `studioHandlers`, adjacent to the transcribe handler:

```ts
// Server video ops (CE ffmpeg_handler, story: server-video-ops). Same fire-and-poll
// shape as /api/transcribe; outputs are written into objectStore so the returned
// serve path actually serves.
http.post('/api/video/extract-audio', async ({ request }) => {
  const body = (await request.json()) as { sourceUrl?: string; projectId?: string }
  if (!body.sourceUrl) return HttpResponse.json({ error: 'sourceUrl required' }, { status: 400 })
  const key = `projects/${body.projectId ?? 'mock'}/audio/server/${Date.now()}.wav`
  objectStore.set(key, new Blob(['mock-wav'], { type: 'audio/wav' }))
  const jobId = enqueueJob('video-extract', { url: `/api/uploads/${key}` })
  return HttpResponse.json({ jobId, status: 'pending' })
}),

http.post('/api/video/slice', async ({ request }) => {
  const body = (await request.json()) as {
    sourceUrl?: string
    spans?: { start: number; end: number }[]
    wantAudio?: boolean
    projectId?: string
  }
  if (!body.sourceUrl || !Array.isArray(body.spans) || body.spans.length === 0) {
    return HttpResponse.json({ error: 'sourceUrl and spans required' }, { status: 400 })
  }
  const pid = body.projectId ?? 'mock'
  const stamp = Date.now()
  const clipKey = `projects/${pid}/scene-clip/server/${stamp}.mp4`
  objectStore.set(clipKey, new Blob(['mock-mp4'], { type: 'video/mp4' }))
  const duration = body.spans.reduce((n, s) => n + (s.end - s.start), 0)
  let audioUrl: string | undefined
  if (body.wantAudio) {
    const wavKey = `projects/${pid}/audio/server/${stamp}.wav`
    objectStore.set(wavKey, new Blob(['mock-wav'], { type: 'audio/wav' }))
    audioUrl = `/api/uploads/${wavKey}`
  }
  const jobId = enqueueJob('video-slice', { url: `/api/uploads/${clipKey}`, audioUrl, duration })
  return HttpResponse.json({ jobId, status: 'pending' })
}),

http.post('/api/video/concat', async ({ request }) => {
  const body = (await request.json()) as { parts?: string[]; projectId?: string }
  if (!Array.isArray(body.parts) || body.parts.length === 0) {
    return HttpResponse.json({ error: 'parts required' }, { status: 400 })
  }
  const key = `projects/${body.projectId ?? 'mock'}/export/server/${Date.now()}.mp4`
  objectStore.set(key, new Blob(['mock-mp4'], { type: 'video/mp4' }))
  const jobId = enqueueJob('video-concat', { url: `/api/uploads/${key}` })
  return HttpResponse.json({ jobId, status: 'pending' })
}),

http.get('/api/video/capabilities', () =>
  HttpResponse.json({ server: true, ops: ['probe', 'extract_audio', 'slice', 'concat'], version: 'ffmpeg 7.0-mock' }),
),
```

Adjust `objectStore.set` value construction to whatever the file actually stores (the research says a Map with a byte cap — mirror the PUT handler's storage form at :96-108; if it stores ArrayBuffers, store those).

- [ ] **Step 2: Verify**

Run: `pnpm --filter studio exec vitest run src/mocks` then `pnpm --filter studio build`
Expected: existing mock tests green (the gate test at handlers.test.ts:9 must still pass); build clean.

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/mocks
git commit -m "feat(studio): MSW mocks for /api/video ops and capabilities"
```

---

### Task 4: rules — capabilities + extract-audio

Authored under `apps/studio/.bffless/proxy-rules/studio/rules/api/video/`. Study the transcribe rule dir first (`rules/api/transcribe/post/`) — the new rules are structural clones. Run `npx bffless rules validate` from the repo root after each rule.

**Files:**
- Create: `.../rules/api/video/capabilities/get.rule.yaml`
- Create: `.../rules/api/video/extract-audio/post/rule.yaml`, `prep.fn.js`, `check.fn.js`, `check.fn.test.yaml`

**Interfaces:**
- Produces: `GET /api/video/capabilities` → `{ server, ops, version }` (never fails); `POST /api/video/extract-audio` body `{ sourceUrl, projectId }` → `{ jobId, status: 'pending' }`, job row `kind: 'video-extract'`, terminal `result: { url }`.
- Consumes: CE `ffmpeg_handler` contract (Global Constraints), `$schema:studio_jobs`, the serve-path convention.

- [ ] **Step 1: capabilities rule** (single-file form — no code siblings)

```yaml
# .../rules/api/video/capabilities/get.rule.yaml
targetUrl: pipeline
order: 56
pipeline:
  name: Server video capability probe
  description: "ffmpeg_handler probe with no input: never fails, returns { server, ops, version }. server:false on instances without ffmpeg or with FFMPEG_HANDLER_ENABLED=false — the FE falls back to wasm. Requires CE >= 0.4.25 for the handler type; on older CE this rule fails to import, which is fine (the FE probe treats any non-200 as wasm)."
  steps:
    - id: probe
      name: probe
      handler: ffmpeg_handler
      config:
        operation: probe
    - id: respond
      name: respond
      handler: response_handler
      config:
        body: "{{{steps.probe}}}"
        status: 200
        headers:
          Cache-Control: no-store
        contentType: application/json
  validators: []
description: "Capability probe for server-side video ops (CE ffmpeg_handler, >= 0.4.25). Synchronous and cheap; no job row. The client calls this once per session."
```

- [ ] **Step 2: extract-audio fn.js + fixture test**

```js
// .../rules/api/video/extract-audio/post/prep.fn.js
function handler({ request }) {
  var body = (request && request.body) || {}
  var sourceUrl = String(body.sourceUrl || '')
  var pid = String(body.projectId || '')
  // The ffmpeg handler accepts /api/uploads/... serve paths directly as input.
  var ok = sourceUrl.indexOf('/api/uploads/') === 0 && sourceUrl.indexOf('..') === -1 && pid !== '' && pid.indexOf('..') === -1 && pid.indexOf('/') === -1
  return { ok: ok, notOk: !ok, input: sourceUrl, projectId: pid }
}
```

```js
// .../rules/api/video/extract-audio/post/check.fn.js
function handler({ steps, deployment }) {
  var out = (steps && steps.extract) || null
  var path = out && out.storage_path
  if (typeof path !== 'string' || !path) {
    return { ok: false, notOk: true, error: 'Server audio extraction failed', data: null }
  }
  // storage path <owner>/<repo>/uploads/<key>  ->  serve URL /api/uploads/<key>
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  var key = path.indexOf(prefix) === 0 ? path.slice(prefix.length) : path
  return { ok: true, notOk: false, error: '', data: { url: '/api/uploads/' + key } }
}
```

```yaml
# .../rules/api/video/extract-audio/post/check.fn.test.yaml
- name: maps storage_path to a serve URL
  input:
    steps:
      extract:
        storage_path: o/r/uploads/projects/p1/audio/server/a.wav
        content_type: audio/wav
        size: 123
    deployment: { owner: o, repo: r }
  expect:
    ok: true
    data: { url: /api/uploads/projects/p1/audio/server/a.wav }
- name: missing step output is a failure
  input:
    steps: {}
    deployment: { owner: o, repo: r }
  expect:
    ok: false
    error: Server audio extraction failed
```

(Check the fixture format against the one existing example, `apps/reader/.bffless/proxy-rules/reader/rules/api/items/star/post/pick.fn.test.yaml`, and adapt keys to what `bffless rules test` actually expects.)

- [ ] **Step 3: the enqueue rule**

```yaml
# .../rules/api/video/extract-audio/post/rule.yaml
targetUrl: ""
order: 57
timeout: 120000
pipeline:
  name: Server audio extract (ffmpeg, async)
  description: "sourceUrl (video already in bucket) -> ENQUEUE a job (kind 'video-extract'); the ffmpeg extract_audio op (16 kHz mono WAV, the transcription contract) runs in postSteps reading and writing the bucket directly. Result { url } polled via /api/studio/job. Mirrors /api/transcribe."
  steps:
    - id: prep
      name: prep
      handler: function_handler
      code: ./prep.fn.js
    - id: badRequest
      name: badRequest
      handler: response_handler
      config:
        condition: steps.prep.notOk
        body: '{ "error": "sourceUrl (an /api/uploads/ path) and projectId are required" }'
        status: 400
        contentType: application/json
    - id: createJob
      name: createJob
      handler: data_create
      config:
        fields:
          kind: "'video-extract'"
          status: "'pending'"
          request: request.body
        schemaId: $schema:studio_jobs
    - id: respond
      name: respond
      handler: response_handler
      config:
        body: |-
          {
            "jobId": "{{steps.createJob.id}}",
            "status": "pending"
          }
        status: 200
        contentType: application/json
  postSteps:
    - id: setRunning
      name: setRunning
      handler: data_update
      config:
        fields:
          status: "'running'"
        recordId: steps.createJob.id
        schemaId: $schema:studio_jobs
    - id: extract
      name: extract
      handler: ffmpeg_handler
      config:
        operation: extract_audio
        input: steps.prep.input
        output: "projects/{{steps.prep.projectId}}/audio/server/{{uuid()}}.wav"
    - id: check
      name: check
      handler: function_handler
      code: ./check.fn.js
    - id: finishOk
      name: finishOk
      handler: data_update
      config:
        fields:
          result: steps.check.data
          status: "'done'"
        recordId: steps.createJob.id
        schemaId: $schema:studio_jobs
        condition: steps.check.ok
    - id: finishErr
      name: finishErr
      handler: data_update
      config:
        fields:
          error: steps.check.error
          status: "'error'"
        recordId: steps.createJob.id
        schemaId: $schema:studio_jobs
        condition: steps.check.notOk
  validators: []
description: "Server-side 16 kHz mono WAV extraction from an uploaded source video via CE's ffmpeg_handler (>= 0.4.25). No secrets. No validators yet (auth deferred to story 07, mirrors the set). Removes the browser's 2 GB decodeAudioData ceiling when active."
```

**Check one thing against the transcribe rule while implementing:** whether a `response_handler` step with a `condition:` that fires actually terminates the pipeline (the early-400 `badRequest` step). If the codebase's rules never early-respond this way (transcribe validates nothing), simplify: drop `badRequest`, let a bad sourceUrl fail in postSteps via `check` — matching the set's existing behavior. Disclose the choice.

- [ ] **Step 4: Validate**

Run from repo root: `npx bffless rules validate && npx bffless rules test`
Expected: both clean (the fn fixtures are the first in the studio set — if `rules test` errors on the fixture format rather than the assertion, fix the format per its error output).

- [ ] **Step 5: Commit**

```bash
git add apps/studio/.bffless
git commit -m "feat(studio): /api/video/capabilities and extract-audio rules (ffmpeg_handler)"
```

---

### Task 5: rules — slice + concat

Same fire-and-poll skeleton as Task 4's extract-audio rule (clone it, don't reinvent). Differences only: the op step(s) and the check fn.

**Files:**
- Create: `.../rules/api/video/slice/post/{rule.yaml,prep.fn.js,check.fn.js,check.fn.test.yaml}`
- Create: `.../rules/api/video/concat/post/{rule.yaml,prep.fn.js,check.fn.js,check.fn.test.yaml}`

**Interfaces:**
- Produces: `POST /api/video/slice` body `{ sourceUrl, spans: [{start,end}], wantAudio: boolean, audioFades: boolean, projectId }` → job `kind: 'video-slice'`, result `{ url, audioUrl?, duration }`. `POST /api/video/concat` body `{ parts: string[], projectId }` → job `kind: 'video-concat'`, result `{ url }`.
- Consumes: `ffmpeg_handler` slice/concat contract; the conditional-step pattern (`finishOk`/`finishErr` quartet from transcribe).

- [ ] **Step 1: slice rule specifics** (`order: 58`, `kind: "'video-slice'"`)

`prep.fn.js` validates like Task 4's plus `spans` (non-empty array of `{start,end}` finite numbers, `0 <= start < end`) and exposes the audio branch flags:

```js
// .../rules/api/video/slice/post/prep.fn.js
function handler({ request }) {
  var body = (request && request.body) || {}
  var sourceUrl = String(body.sourceUrl || '')
  var pid = String(body.projectId || '')
  var spans = body.spans
  var spansOk = Array.isArray(spans) && spans.length > 0
  if (spansOk) {
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i]
      var start = s && Number(s.start)
      var end = s && Number(s.end)
      if (!(isFinite(start) && isFinite(end) && start >= 0 && end > start)) { spansOk = false; break }
    }
  }
  var ok = sourceUrl.indexOf('/api/uploads/') === 0 && sourceUrl.indexOf('..') === -1 && pid !== '' && pid.indexOf('..') === -1 && pid.indexOf('/') === -1 && spansOk
  var wantAudio = body.wantAudio === true
  return {
    ok: ok, notOk: !ok,
    input: sourceUrl, projectId: pid, spans: spans,
    wantAudio: wantAudio, noAudio: !wantAudio,
    audioFades: body.audioFades === true,
  }
}
```

postSteps use **two conditional `ffmpeg_handler` steps** (the finishOk/finishErr conditional idiom — handler config is static per rule, so the audioOutput variant needs its own step):

```yaml
    - id: sliceWithAudio
      name: sliceWithAudio
      handler: ffmpeg_handler
      config:
        condition: steps.prep.wantAudio
        operation: slice
        input: steps.prep.input
        spans: steps.prep.spans
        audioFades: steps.prep.audioFades
        output: "projects/{{steps.prep.projectId}}/scene-clip/server/{{uuid()}}.mp4"
        audioOutput: "projects/{{steps.prep.projectId}}/audio/server/{{uuid()}}.wav"
    - id: sliceOnly
      name: sliceOnly
      handler: ffmpeg_handler
      config:
        condition: steps.prep.noAudio
        operation: slice
        input: steps.prep.input
        spans: steps.prep.spans
        audioFades: steps.prep.audioFades
        output: "projects/{{steps.prep.projectId}}/export/server/{{uuid()}}.mp4"
```

**Verify one contract detail against the CE handler TSDoc before authoring** (read `repos/ce`'s `apps/backend/src/pipelines/execution/step-handler.interface.ts` FfmpegHandlerConfig on main): whether `audioFades` accepts an expression string (the CE handler checks `config.audioFades === true` — a truthy string would be FALSE). If strict-boolean, either author two more conditional variants or — simpler — pass `audioFades` only where it's constant per call site: cut always `false`, assemble always `true`, so `steps.prep.audioFades` resolving to a boolean via the expression evaluator works ONLY if the evaluator returns the actual boolean from `request.body`. `evaluateExpression('steps.prep.audioFades')` returns the real boolean from the fn output — so this works. Confirm by reading the CE expression evaluator's property resolution (it returns raw values, not strings) and note the finding in the report.

`check.fn.js` reads whichever step ran:

```js
// .../rules/api/video/slice/post/check.fn.js
function handler({ steps, deployment }) {
  var out = (steps && (steps.sliceWithAudio || steps.sliceOnly)) || null
  var path = out && out.storage_path
  if (typeof path !== 'string' || !path) {
    return { ok: false, notOk: true, error: 'Server slice failed', data: null }
  }
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  function toUrl(p) {
    var key = p.indexOf(prefix) === 0 ? p.slice(prefix.length) : p
    return '/api/uploads/' + key
  }
  var audio = out.audio && typeof out.audio.storage_path === 'string' ? toUrl(out.audio.storage_path) : null
  return {
    ok: true, notOk: false, error: '',
    data: { url: toUrl(path), audioUrl: audio, duration: typeof out.duration === 'number' ? out.duration : null },
  }
}
```

Fixture test (`check.fn.test.yaml`): three cases — with-audio output maps both URLs; audio-less output maps url only, audioUrl null; missing step output → error 'Server slice failed'.

- [ ] **Step 2: concat rule specifics** (`order: 59`, `kind: "'video-concat'"`)

`prep.fn.js`: validate `parts` is a non-empty array of `/api/uploads/...` strings (no `..`), pid as before; return `{ ok, notOk, parts, projectId }`. Single postSteps op:

```yaml
    - id: stitch
      name: stitch
      handler: ffmpeg_handler
      config:
        operation: concat
        inputs: steps.prep.parts
        output: "projects/{{steps.prep.projectId}}/export/server/{{uuid()}}.mp4"
```

`check.fn.js`: same shape as extract-audio's (single `steps.stitch`, result `{ url }`), error string 'Server stitch failed'. Fixture test: success + missing-output cases.

- [ ] **Step 3: Validate**

Run: `npx bffless rules validate && npx bffless rules test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/studio/.bffless
git commit -m "feat(studio): /api/video/slice and concat rules (ffmpeg_handler fire-and-poll)"
```

---

### Task 6: client — the scene cut goes server-side

Branch inside `sliceScene` (`useScenePipeline.ts:1300-1334`), plus the `pollJob` timeout parameter every video op shares.

**Files:**
- Modify: `apps/studio/src/components/Studio/useScenePipeline.ts`
- Test: extend the pipeline's existing test file if one covers `sliceScene`; otherwise add `apps/studio/src/components/Studio/useScenePipeline.videoBackend.test.tsx` exercising the branch through the hook with MSW mocks (mirror how `useAutoBuild.test.tsx` renders hooks). If hook-level testing proves disproportionate, test the extracted pure pieces and rely on the mock-driven build; disclose the choice.

**Interfaces:**
- Produces: `pollJob(jobId, opts?: { timeoutMs?: number })` (default 5 min unchanged); `const VIDEO_POLL_TIMEOUT_MS = 35 * 60 * 1000` (> CE's FFMPEG_MAX_SECONDS 1800 s watchdog, so the server, not the client, decides wedged); server-path `sliceScene`.
- Consumes: Task 1 mutations + `toVideoResult`, Task 2 `getVideoBackend`, Task 3 mocks.

- [ ] **Step 1: extend `pollJob`** (:409-423): add the options param, replace the constant use:

```ts
const pollJob = useCallback(
  async (jobId: string, opts?: { timeoutMs?: number }): Promise<{ kind: StudioJob['kind']; result: unknown }> => {
    const deadline = Date.now() + (opts?.timeoutMs ?? POLL_TIMEOUT_MS)
    ...
```

(Only the deadline line changes; keep the loop verbatim.)

- [ ] **Step 2: branch `sliceScene`**. At the top of the existing implementation (after the scene/source lookups, before `sourceBlobs.get`):

```ts
if ((await getVideoBackend()) === 'server') {
  // Server path: the source never leaves the bucket. One job cuts the clip AND
  // emits its 16k WAV (audioOutput) — replacing the wasm slice + WebAudio
  // sliceAudioWav + two uploads.
  const { jobId } = await videoSliceStartReq({
    sourceUrl: src.sourceUrl,
    spans: [{ start: scene.start, end: scene.end }],
    wantAudio: true,
    audioFades: false, // cut parity: slice.ts has no fades
    projectId: activeProjectId,
  }).unwrap()
  const job = await pollJob(jobId, { timeoutMs: VIDEO_POLL_TIMEOUT_MS })
  const out = toVideoResult(job.result)
  if (!out.audioUrl) throw new Error('Server cut finished without a soundtrack WAV.')
  patchSceneEdit(sceneId, { clipUrl: out.url, clipAudioUrl: out.audioUrl })
  return
}
// ...existing wasm path unchanged below...
```

Wire `videoSliceStartReq` the way `transcribeStartReq` is wired in this hook (find its `useXMutation()` destructure near the top and mirror). Keep the existing error handling contract: `sliceScene` failures are swallowed into `sceneErrors[sceneId]` by the surrounding catch (:1327-1329) — the server branch must throw INTO that catch, not around it (place the branch inside the same try).

- [ ] **Step 3: Verify**

Run: `pnpm --filter studio exec vitest run src/components/Studio` (whatever exists must stay green) and `pnpm --filter studio build`. If you added the hook-level test: it drives a mock-backed cut and asserts `patchSceneEdit` got `/api/uploads/...` values from the mock, plus a `?videoBackend=wasm`-forced run still takes the wasm path (assert the wasm exec mock was called).
Expected: green, build clean.

- [ ] **Step 4: Commit**

```bash
git add apps/studio/src
git commit -m "feat(studio): server-side scene cut behind the video backend probe"
```

---

### Task 7: client — assemble + stitch go server-side

The blob-producing seam (`assembleScene.ts`) stays untouched; branching happens at its three call sites, via two new remote functions on the Pipe.

**Files:**
- Modify: `apps/studio/src/components/Studio/useScenePipeline.ts` (add `assembleSceneRemote`, `stitchFinalCutRemote`, expose on the returned pipe object)
- Modify: `apps/studio/src/components/Studio/useAutoBuild.ts` (:268-276 assemble, :198-218 stitch; also its `Pipe` type at :61-71)
- Modify: `apps/studio/src/components/Studio/SceneAssembleBar.tsx` (:82-94), `apps/studio/src/components/Studio/FinalCutBar.tsx` (:68-95)
- Test: extend `apps/studio/src/components/Studio/useAutoBuild.test.tsx` (it mocks `assembleSceneBlob`/`assembleFinalCutBlob` at :25-32 — add a server-backend case where those mocks are NOT called and the remote fns are)

**Interfaces:**
- Produces: `assembleSceneRemote(sceneId)` — computes the clip-local plan via `planScene({ cuts: effectiveCuts(scene), start: scene.start, end: scene.end })` (import from `../../lib/export/assemble`; check how `assembleScene.ts:33` derives the cuts and mirror exactly), enqueues `videoSliceStart({ sourceUrl: scene.clipUrl, spans: plan.video, wantAudio: false, audioFades: true, projectId })`, polls with `VIDEO_POLL_TIMEOUT_MS`, then `patchScene(sceneId, { assembledUrl: out.url, status: 'built' })`. THROWS on failure (assemble regime — halts auto-build, :230-237).
- Produces: `stitchFinalCutRemote()` — single-scene shortcut FIRST (mirror `assembleScene.ts:64`: one scene → `dispatch(setFinalCutUrl(scene.assembledUrl))`... check what the wasm path actually does with a single scene's blob and produce the equivalent URL semantics; if the wasm path re-uploads the single blob as an export, the server equivalent is `videoConcatStart` with one part — pick whichever preserves observable behavior and disclose); otherwise `videoConcatStart({ parts: scenes.map(s => s.assembledUrl), projectId })` → poll → `dispatch(setFinalCutUrl(out.url))`. Throws on failure.
- Consumes: Tasks 1-3, `getVideoBackend`, `planScene` + `effectiveCuts` (from `src/lib/scenes.ts` — verify the import name at `assembleScene.ts`'s own imports).

- [ ] **Step 1: Write the failing test** (in `useAutoBuild.test.tsx`, following its existing mock/render harness): with the pipe's backend forced to server (mock `getVideoBackend` → 'server' via `vi.mock('../../lib/videoBackend', ...)`), an assemble step calls `pipe.assembleSceneRemote` and never `assembleSceneBlob`; with 'wasm' the existing expectations hold unchanged.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter studio exec vitest run src/components/Studio/useAutoBuild.test.tsx`
Expected: new cases FAIL (remote fns missing).

- [ ] **Step 3: Implement**

In `useScenePipeline.ts` (near `saveSceneCut` :1562):

```ts
const assembleSceneRemote = useCallback(
  async (sceneId: string) => {
    const scene = scenesRef.current.find((s) => s.id === sceneId) // mirror how sliceScene looks up scenes
    if (!scene?.clipUrl) throw new Error('Scene has no clip to assemble.')
    const plan = planScene({ cuts: effectiveCuts(scene), start: scene.start, end: scene.end })
    if (plan.video.length === 0) throw new Error('Nothing to render — every span is cut.')
    const { jobId } = await videoSliceStartReq({
      sourceUrl: scene.clipUrl,
      spans: plan.video,
      wantAudio: false,
      audioFades: true, // assemble parity: buildFfmpegCommand's ~10ms edge fades
      projectId: activeProjectId,
    }).unwrap()
    const job = await pollJob(jobId, { timeoutMs: VIDEO_POLL_TIMEOUT_MS })
    const out = toVideoResult(job.result)
    patchScene(sceneId, { assembledUrl: out.url, status: 'built' })
  },
  [/* mirror saveSceneCut's dep list + the new mutation */],
)
```

(Adapt the scene lookup, `patchScene`, and dep arrays to the hook's actual local names — read the neighboring functions and match them; the research's line anchors get you there.)

`stitchFinalCutRemote` alongside `saveFinalCut` (:1540), per the Interfaces block.

Call sites (each becomes an async branch; `getVideoBackend()` await is fine inside these handlers):

```ts
// useAutoBuild.ts runStep, assemble arm (:268-276):
if ((await getVideoBackend()) === 'server') return p.assembleSceneRemote(scene.id)
// existing renderRef/blob/save path unchanged below

// useAutoBuild.ts stitch action (:198-218):
if ((await getVideoBackend()) === 'server') { await p.stitchFinalCutRemote(); ... mirror the existing completion dispatch }

// SceneAssembleBar.run (:82): branch before assembleSceneBlob; server path sets stage text
// 'Rendering on the server…' (no granular progress — the poll is status-only) then pipe.assembleSceneRemote(scene.id)
// FinalCutBar.run (:68): same shape with stitchFinalCutRemote
```

Extend `useAutoBuild.ts`'s `Pipe` type (:61-71) with the two new fns.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter studio exec vitest run src/components/Studio` and `pnpm --filter studio build`
Expected: green (old wasm-path tests untouched), build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/studio/src
git commit -m "feat(studio): server-side scene assemble and final stitch"
```

---

### Task 8: client — audio extract goes server-side

Both extract seams (`extractAndUploadAudio` :843-864 and `processSource` :1016-1074) get the same branch: server WAV, then peaks/deadSpace derived from the (small, 16 kHz) WAV url via the existing helpers — the browser never decodes the source video, removing the `MAX_SOURCE_BYTES` ceiling on the server path.

**Files:**
- Modify: `apps/studio/src/components/Studio/useScenePipeline.ts`
- Test: pure-piece coverage only (the flow is exercised by Task 9's mock run); any extracted helper gets a colocated test

**Interfaces:**
- Consumes: `videoExtractStart` (Task 1), `getVideoBackend` (Task 2), existing `peaksFromUrl` + `deadSpaceFromUrl` (`src/lib/audio.ts:105,119`).
- Produces: identical state writes to the wasm path — `setAudioUrl(url)`, `setAudioPeaks(peaks)`, `setDeadSpace(dead)`, `patchSource({ audioUrl, audioPeaks, deadSpace })` (match each seam's exact write set; the two call sites differ slightly — :853-857 vs the per-source writes near :1046).

- [ ] **Step 1: Implement the branch** (shown for the :849 seam; mirror at :1046 with that site's writes):

```ts
if ((await getVideoBackend()) === 'server') {
  // sourceUrl is the already-uploaded video's serve path (upload precedes extract
  // in STAGE_DEFS — spec: "prep ordering already fits").
  const { jobId } = await videoExtractStartReq({ sourceUrl, projectId: activeProjectId }).unwrap()
  const job = await pollJob(jobId, { timeoutMs: VIDEO_POLL_TIMEOUT_MS })
  const { url } = toVideoResult(job.result)
  // Derive the visual artifacts from the 16k WAV (small) — the source video is
  // never decoded in the browser on this path.
  const [peaks, dead] = await Promise.all([peaksFromUrl(url), deadSpaceFromUrl(url)])
  dispatch(setAudioUrl(url))
  setAudioPeaks(peaks)
  setDeadSpace(dead)
  patchSource({ audioUrl: url, audioPeaks: peaks, deadSpace: dead })
  return
}
// ...existing WebAudio path unchanged...
```

**Check while implementing:** what `sourceUrl` variable each seam actually has in scope (the :849 seam receives a `File` — it may run BEFORE the upload stage completes; read the STAGE_DEFS ordering in `src/lib/pipeline.ts` and the seam's surrounding code). If the extract stage at :849 only has the File and the uploaded URL isn't available yet, the server branch belongs AFTER the upload write — follow the actual data flow and disclose how you placed it. The `processSource` (:1046) path per-source has `source.sourceUrl` available. If the legacy :849 seam can't cleanly get a source URL, it's acceptable to server-route ONLY the `processSource` path and leave the legacy single-source path on WebAudio — disclose if so.

- [ ] **Step 2: Verify**

Run: `pnpm --filter studio exec vitest run src/components/Studio src/lib` and `pnpm --filter studio build`
Expected: green; build clean.

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src
git commit -m "feat(studio): server-side audio extraction with WAV-derived peaks"
```

---

### Task 9: docs, counts, and full verification

**Files:**
- Modify: `apps/studio/CLAUDE.md` (:32-33 "40 rules" → 44; add one line: server video ops via `/api/video/*` on CE ≥ 0.4.25, `?videoBackend=server|wasm` override)
- Modify: `apps/studio/bffless/README.md` (:17-19 count; a short "Server video ops" subsection: capability probe, CE ≥ 0.4.25 unlocks, wasm fallback otherwise, no new secrets)
- Modify: `docs/bffless-backend-inventory.md` (:82 count — note it already says 39, make it 44 and correct; add the four endpoints to the endpoint table ~:100-146)
- Modify: `apps/studio/stories/14-headless-run.md` (:176-181 follow-up note → mark the epic landed, pointer to this plan)
- Verify: everything

- [ ] **Step 1: Docs edits** per above. Do NOT touch `bffless-app.json` `ceMin` (Global Constraints).

- [ ] **Step 2: Full verification** (from repo root):

```bash
pnpm --filter studio build && pnpm --filter studio lint && pnpm --filter studio test:run
pnpm apps:check
npx bffless rules validate && npx bffless rules test
```

Expected: all green. (`lint` must be clean for studio — unlike CE's frontend, this app's lint gate is real per its CLAUDE.md "build, lint, test:run must pass".)

- [ ] **Step 3: Mock smoke run** — headless validation per `localdev-tools/README.md`: start `pnpm studio:dev`, then from `localdev-tools/` run `node shot.mjs 'http://localhost:5173/?mocks=on' --out /tmp/claude-1000/-home-rico-bffless/*/scratchpad/studio-video.png --full`; expect `consoleErrors:0, failedRequests:0`. (Deeper interactive checks via chrome-devtools MCP if something looks off. This validates wiring, not ffmpeg.)

- [ ] **Step 4: Commit**

```bash
git add apps/studio docs
git commit -m "docs(studio): server video ops — rule counts, README, inventory"
```

---

## Live verification (post-plan, before/at PR)

Rules only sync to j5s.dev on merge to main (preview PRs are dry-run). Two options, in order:

1. **Pre-merge, suffixed set:** `BFFLESS_API_KEY=... npx bffless rules push apps/studio/.bffless/proxy-rules/studio --name-suffix server-video --dry-run` then real push; attach `studio-server-video` to the `studio-preview` alias; run the app against it with `?videoBackend=server`. Tear the suffixed set down after.
2. **Post-merge:** dispatch a headless Studio run (the story-14 workflow) and confirm Build lands in single-digit minutes with `/api/*` latency staying interactive during encodes (spec success criteria 1-2), plus the wasm fallback on a `?videoBackend=wasm` run.

The controller (not a subagent) drives live verification — it touches the live project.

## Out of scope / follow-ups

- Per-scene video job-id persistence for reload-resume (wasm path lacks it too; a reload mid-job re-runs the step — same as today).
- Dropping the MT wasm core (patch script, `.npmrc`, COOP/COEP rule) once server ops are proven — a real simplification, separate PR.
- `BrowserSupportBanner` conditioning (Chrome works fine on the server path).
- Surfacing distinct server error codes (FFMPEG_BUSY backoff) — needs CE postSteps error propagation; generic job errors for v1, client falls back to wasm per-op only via the probe, not per-error.
- Deleting `sliceManyAudioWav` (already dead code — noted, not this PR).

## Self-review notes (spec Part 2 → plan coverage)

- Rules `/api/video/{slice,concat,extract-audio,capabilities}` → Tasks 4-5 (poll reuses `/api/studio/job` — kind-agnostic, better than the spec's `/api/video/jobs` sketch and within its "existing pattern" intent); job rows in the existing `studio_jobs` table with new kinds → Tasks 4-5.
- Client backend chosen once per session by capability probe; sliceScene/assemble/stitch/extractAudio become "server when capable, wasm otherwise" → Tasks 2, 6-8. MSW mocks same shapes → Task 3.
- Scheduler ffmpeg lane maps 1:1 onto server concurrency-1, no change → Global Constraints (explicit non-change).
- Prep ordering (upload before extract) → Task 8 (with a real-data-flow check at the legacy seam).
- Fallback matrix (older CE → wasm identical to today) → Task 2's never-reject probe + untouched wasm modules; `ceMin` unchanged per spec.
- Headless runner zero changes → nothing in this plan touches `.github/workflows` or runner code.
