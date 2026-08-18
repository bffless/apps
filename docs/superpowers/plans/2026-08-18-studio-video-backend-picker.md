# Studio Video Backend Picker + Parallel Auto Build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Studio choose where video ops run — Browser (wasm) / Server (auto) / Local server / Remote — send that choice to CE as the step `executor`, and let Auto Build run up to `min(8, scenes)` ffmpeg steps in parallel when the effective executor is Remote, degrading gracefully on `FFMPEG_BUSY`.

**Architecture:** `src/lib/videoBackend.ts` becomes the one resolver: URL override → stored choice → probe (`/api/video/capabilities`), validated against the probe's `executors`, exposing the choice, the *effective* executor, and a fallback note. Call sites send `executor` on the three video job bodies (rules pass it through as `executor: "{{request.body.executor}}"`), the ffmpeg lane in `lib/autoBuild.ts` becomes a counted lane whose capacity `useAutoBuild` decides once per Start/Resume, and a job-level BUSY retry wraps start+poll in `useScenePipeline`. A small `VideoBackendPicker` shows/switches the choice on the Auto Build board and the prep card.

**Tech Stack:** React 19 + Vite + RTK Query, Vitest + Testing Library + MSW (`apps/studio`), BFFless rules-as-code (`.bffless/proxy-rules/studio`, `npx bffless rules test`), pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-08-18-studio-video-backend-picker-design.md` (this repo) — read it first; it argues the decisions P1–P9. Upstream contract: `bffless/ce` `docs/superpowers/specs/2026-08-17-ffmpeg-remote-executor-design.md`.

## Global Constraints

- Work in the worktree `repos/apps/.claude/worktrees/studio-video-backend-picker` (branch `feat/studio-video-backend-picker`); run all commands from `<worktree>/apps/studio` unless stated. **Never edit the main checkout** (`repos/apps` is on another branch) — verify `git rev-parse --show-toplevel` before editing.
- Tests: `pnpm exec vitest run <path>` from `apps/studio` (`pnpm test:run` for the whole suite). Rule fixtures: `cd .bffless/proxy-rules && npx bffless rules test studio` (baseline: 12 passed).
- Lint/typecheck before each commit: `pnpm exec tsc -b --noEmit 2>/dev/null || pnpm exec tsc -p tsconfig.app.json --noEmit` and `pnpm exec eslint <changed files>`.
- Choice values are exactly `'wasm' | 'server' | 'local' | 'remote'` (`browser` accepted as an input alias of `wasm`; the UI label for `wasm` is **Browser**, for `server` **Server (auto)**, for `local` **Local server**, for `remote` **Remote**).
- Executor sent to CE: `remote → 'remote'`, `local → 'local'`, everything else → field omitted.
- Lane capacity: `wasm = 1`, `local = 1`, `remote = min(8, sceneCount)`; refine/sheets lanes stay 1.
- BUSY retry: 4 attempts total, delays 15 s → 30 s → 60 s; classifier `/FFMPEG_BUSY/`.
- Commit locally after each task (conventional commit, `feat(studio): …` / `test(studio): …` / `docs(studio): …`). **Do not push or open a PR** — a PR is a live rule deploy (preview set) and the user must approve.
- Comments follow the repo's house style: explain *why* (see existing headers in `autoBuild.ts` / `useAutoBuild.ts`).

---

### Task 1: Widen the resolver — `lib/videoBackend.ts`

**Files:**
- Modify: `apps/studio/src/lib/videoBackend.ts` (rewrite)
- Modify: `apps/studio/src/lib/videoBackend.test.ts` (rewrite)

**Interfaces:**
- Produces (used by every later task):
  ```ts
  export type VideoBackend = 'wasm' | 'server' | 'local' | 'remote'
  export type VideoExecutor = 'local' | 'remote'
  export type VideoCapabilities = { server: boolean; executors: VideoExecutor[]; defaultExecutor: VideoExecutor | null; remote: { ready: boolean; version?: string; reason?: string } | null }
  export type ResolvedVideoBackend = { backend: VideoBackend; executor: VideoExecutor | null; source: 'override' | 'stored' | 'probe'; note: string | null; probe: VideoCapabilities | null }
  export function asBackend(v: unknown): VideoBackend | null            // accepts 'browser' as alias → 'wasm'
  export function parseCapabilities(raw: unknown): VideoCapabilities
  export function resolveVideoBackend(search: string, stored: string | null, probe: VideoCapabilities | null): ResolvedVideoBackend
  export function stepExecutor(backend: VideoBackend): VideoExecutor | undefined
  export function getResolvedVideoBackend(): Promise<ResolvedVideoBackend>
  export function getVideoBackend(): Promise<VideoBackend>              // = (await getResolvedVideoBackend()).backend
  export function setVideoBackend(choice: VideoBackend): void           // persist + reset memo + notify
  export function subscribeVideoBackend(listener: () => void): () => void
  export function resetVideoBackendForTests(): void
  export const VIDEO_BACKEND_LABEL: Record<VideoBackend, string>        // wasm:'Browser', server:'Server (auto)', local:'Local server', remote:'Remote'
  ```

- [ ] **Step 1: Replace the test file with the new matrix**

Write `apps/studio/src/lib/videoBackend.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  asBackend,
  parseCapabilities,
  resolveVideoBackend,
  stepExecutor,
  getVideoBackend,
  getResolvedVideoBackend,
  setVideoBackend,
  subscribeVideoBackend,
  resetVideoBackendForTests,
  type VideoCapabilities,
} from './videoBackend'

const NONE: VideoCapabilities = { server: false, executors: [], defaultExecutor: null, remote: null }
const LOCAL_ONLY: VideoCapabilities = { server: true, executors: ['local'], defaultExecutor: 'local', remote: null }
const REMOTE_ONLY: VideoCapabilities = {
  server: true, executors: ['remote'], defaultExecutor: 'remote', remote: { ready: true, version: 'preview' },
}
const BOTH: VideoCapabilities = { server: true, executors: ['local', 'remote'], defaultExecutor: 'remote', remote: { ready: true } }

describe('asBackend', () => {
  it('accepts the four choices and the browser alias', () => {
    expect(asBackend('wasm')).toBe('wasm')
    expect(asBackend('browser')).toBe('wasm')
    expect(asBackend('server')).toBe('server')
    expect(asBackend('local')).toBe('local')
    expect(asBackend('remote')).toBe('remote')
    expect(asBackend('nope')).toBeNull()
    expect(asBackend(null)).toBeNull()
  })
})

describe('parseCapabilities', () => {
  it('reads the CE >= 0.4.31 payload', () => {
    expect(
      parseCapabilities({ server: true, ops: ['probe'], version: null, executors: ['remote'], defaultExecutor: 'remote', remote: { ready: true, version: 'v' } }),
    ).toEqual({ server: true, executors: ['remote'], defaultExecutor: 'remote', remote: { ready: true, version: 'v' } })
  })
  it('tolerates the pre-remote payload (no executors): server:true means local only', () => {
    expect(parseCapabilities({ server: true, ops: ['probe'], version: 'ffmpeg 7' })).toEqual({
      server: true, executors: ['local'], defaultExecutor: 'local', remote: null,
    })
    expect(parseCapabilities({ server: false, ops: [], version: null })).toEqual(NONE)
  })
  it('drops unknown executor names and garbage', () => {
    expect(parseCapabilities({ server: true, executors: ['local', 'gpu'], defaultExecutor: 'gpu' })).toEqual({
      server: true, executors: ['local'], defaultExecutor: 'local', remote: null,
    })
    expect(parseCapabilities(null)).toEqual(NONE)
  })
})

describe('resolveVideoBackend (pure)', () => {
  it('a ?videoBackend override beats everything, and browser is an alias of wasm', () => {
    expect(resolveVideoBackend('?videoBackend=wasm', 'remote', BOTH)).toMatchObject({ backend: 'wasm', executor: null, source: 'override' })
    expect(resolveVideoBackend('?videoBackend=browser', null, BOTH).backend).toBe('wasm')
    expect(resolveVideoBackend('?videoBackend=server', null, NONE)).toMatchObject({ backend: 'server', source: 'override', note: null })
  })
  it('a stored choice beats the probe', () => {
    expect(resolveVideoBackend('', 'wasm', BOTH)).toMatchObject({ backend: 'wasm', source: 'stored' })
  })
  it('defaults by probe capability', () => {
    expect(resolveVideoBackend('', null, LOCAL_ONLY)).toMatchObject({ backend: 'server', executor: 'local', source: 'probe' })
    expect(resolveVideoBackend('', null, NONE)).toMatchObject({ backend: 'wasm', executor: null, source: 'probe' })
    expect(resolveVideoBackend('', null, null)).toMatchObject({ backend: 'wasm', executor: null, source: 'probe' })
  })
  it('server (auto) reports the instance default as its effective executor', () => {
    expect(resolveVideoBackend('', 'server', REMOTE_ONLY).executor).toBe('remote')
    expect(resolveVideoBackend('', 'server', LOCAL_ONLY).executor).toBe('local')
    // no probe / pre-remote CE: assume local (conservative for the lane cap)
    expect(resolveVideoBackend('', 'server', null).executor).toBe('local')
  })
  it('remote / local are honoured only when the probe lists them', () => {
    expect(resolveVideoBackend('', 'remote', BOTH)).toMatchObject({ backend: 'remote', executor: 'remote', note: null })
    expect(resolveVideoBackend('?videoBackend=local', null, BOTH)).toMatchObject({ backend: 'local', executor: 'local', note: null })
  })
  it('falls back to server (auto) with a note when the executor is missing but server ops exist', () => {
    const r = resolveVideoBackend('', 'remote', LOCAL_ONLY)
    expect(r).toMatchObject({ backend: 'server', executor: 'local', source: 'stored' })
    expect(r.note).toMatch(/Remote isn't enabled on this instance/)
    const l = resolveVideoBackend('?videoBackend=local', null, REMOTE_ONLY)
    expect(l).toMatchObject({ backend: 'server', executor: 'remote', source: 'override' })
    expect(l.note).toMatch(/Local server isn't enabled/)
  })
  it('falls back to wasm with a note when there are no server ops at all', () => {
    const r = resolveVideoBackend('', 'remote', NONE)
    expect(r).toMatchObject({ backend: 'wasm', executor: null })
    expect(r.note).toMatch(/Remote isn't enabled/)
  })
  it('falls back to server (auto) when the probe failed (executors unknown)', () => {
    const r = resolveVideoBackend('', 'remote', null)
    expect(r).toMatchObject({ backend: 'server', executor: 'local' })
    expect(r.note).toMatch(/couldn't be verified/)
  })
  it('garbage values fall through to the probe default', () => {
    expect(resolveVideoBackend('?videoBackend=nope', 'nope', LOCAL_ONLY).backend).toBe('server')
  })
})

describe('stepExecutor', () => {
  it('names the executor only for explicit choices', () => {
    expect(stepExecutor('remote')).toBe('remote')
    expect(stepExecutor('local')).toBe('local')
    expect(stepExecutor('server')).toBeUndefined()
    expect(stepExecutor('wasm')).toBeUndefined()
  })
})

describe('getVideoBackend / getResolvedVideoBackend (session memo)', () => {
  afterEach(() => {
    resetVideoBackendForTests()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  const probeReply = (caps: object) => new Response(JSON.stringify(caps))

  it('probes once and memoizes — concurrent callers share one fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(probeReply({ server: true, executors: ['local'], defaultExecutor: 'local' }))
    vi.stubGlobal('fetch', fetchMock)
    const [a, b] = await Promise.all([getVideoBackend(), getVideoBackend()])
    expect(a).toBe('server')
    expect(b).toBe('server')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never rejects: probe failure resolves wasm (older CE runs exactly as today)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(getVideoBackend()).resolves.toBe('wasm')
  })

  it('a stored wasm choice never touches the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.setItem('videoBackend', 'wasm')
    await expect(getVideoBackend()).resolves.toBe('wasm')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a stored server-side choice still probes (to validate it and learn the default executor)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(probeReply({ server: true, executors: ['remote'], defaultExecutor: 'remote', remote: { ready: true } }))
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.setItem('videoBackend', 'remote')
    const r = await getResolvedVideoBackend()
    expect(r).toMatchObject({ backend: 'remote', executor: 'remote', source: 'stored', note: null })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a stored server choice survives a failed probe (today’s behaviour), with a local cap', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    window.localStorage.setItem('videoBackend', 'server')
    expect(await getResolvedVideoBackend()).toMatchObject({ backend: 'server', executor: 'local', source: 'stored' })
  })

  it('setVideoBackend persists, resets the memo and notifies subscribers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(probeReply({ server: true, executors: ['local', 'remote'], defaultExecutor: 'local', remote: { ready: true } })))
    const listener = vi.fn()
    const unsub = subscribeVideoBackend(listener)
    expect((await getResolvedVideoBackend()).backend).toBe('server')
    setVideoBackend('remote')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem('videoBackend')).toBe('remote')
    expect((await getResolvedVideoBackend()).backend).toBe('remote')
    unsub()
    setVideoBackend('wasm')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run src/lib/videoBackend.test.ts`
Expected: FAIL (missing exports `asBackend`, `parseCapabilities`, …).

- [ ] **Step 3: Rewrite `videoBackend.ts`**

```ts
/**
 * Which backend runs video ops this session (spec: docs/superpowers/specs/
 * 2026-08-18-studio-video-backend-picker-design.md, P1–P4):
 *
 *   wasm    — in the browser (ffmpeg.wasm / WebAudio); labelled "Browser"
 *   server  — CE's ffmpeg_handler, CE picks its default executor ("Server (auto)")
 *   local   — CE, forcing the Local executor (ffmpeg inside the backend)
 *   remote  — CE, forcing the Remote executor (Cloud Run Worker)
 *
 * Mirrors resolveCoreChoice (export/ffmpeg.ts): a ?videoBackend= URL override
 * wins and is persisted to localStorage; otherwise a stored choice; otherwise
 * the probe (GET /api/video/capabilities) decides. The probe now ALWAYS runs
 * once per session for any server-side choice — it validates `remote`/`local`
 * against the instance's `executors` and supplies `defaultExecutor`, which is
 * what Auto Build's ffmpeg-lane capacity is decided from. The probe can never
 * break the app — any failure resolves like an older CE (wasm unless a stored
 * server choice says otherwise).
 */
import { fetchWithReauth } from './auth'

export type VideoBackend = 'wasm' | 'server' | 'local' | 'remote'
export type VideoExecutor = 'local' | 'remote'

export type VideoCapabilities = {
  server: boolean
  executors: VideoExecutor[]
  defaultExecutor: VideoExecutor | null
  remote: { ready: boolean; version?: string; reason?: string } | null
}

export type ResolvedVideoBackend = {
  /** The honoured choice (after fallback). */
  backend: VideoBackend
  /** The executor the instance will actually use for `backend` (null for wasm). */
  executor: VideoExecutor | null
  source: 'override' | 'stored' | 'probe'
  /** Human-readable reason when the requested choice could not be honoured. */
  note: string | null
  probe: VideoCapabilities | null
}

export const VIDEO_BACKEND_LABEL: Record<VideoBackend, string> = {
  wasm: 'Browser',
  server: 'Server (auto)',
  local: 'Local server',
  remote: 'Remote',
}

const STORAGE_KEY = 'videoBackend'

export function asBackend(v: unknown): VideoBackend | null {
  if (v === 'browser') return 'wasm'
  return v === 'wasm' || v === 'server' || v === 'local' || v === 'remote' ? v : null
}

function asExecutor(v: unknown): VideoExecutor | null {
  return v === 'local' || v === 'remote' ? v : null
}

/** Coerce the probe payload. Pre-remote CE (no `executors`) with server:true means Local only. */
export function parseCapabilities(raw: unknown): VideoCapabilities {
  const r = (raw ?? {}) as Record<string, unknown>
  const server = r.server === true
  let executors: VideoExecutor[]
  if (Array.isArray(r.executors)) {
    executors = r.executors.map(asExecutor).filter((e): e is VideoExecutor => e !== null)
  } else {
    executors = server ? ['local'] : []
  }
  const configured = asExecutor(r.defaultExecutor)
  const defaultExecutor = configured && executors.includes(configured) ? configured : (executors[0] ?? null)
  const rem = r.remote as Record<string, unknown> | undefined
  const remote =
    rem && typeof rem === 'object'
      ? {
          ready: rem.ready === true,
          ...(typeof rem.version === 'string' ? { version: rem.version } : {}),
          ...(typeof rem.reason === 'string' ? { reason: rem.reason } : {}),
        }
      : null
  return { server, executors, defaultExecutor, remote }
}

/** The `executor` a step body should carry: only explicit choices name one. */
export function stepExecutor(backend: VideoBackend): VideoExecutor | undefined {
  return backend === 'remote' || backend === 'local' ? backend : undefined
}

/**
 * Pure resolution. An override beats a stored choice, which beats the probe.
 * `remote`/`local` are honoured only when the probe lists them; otherwise they
 * fall back to `server` (auto) when the instance has server ops, else `wasm`,
 * with a note. `server`/`wasm` are always honoured as-is (an override "for
 * testing" must win even against a probe that disagrees — today's behaviour).
 */
export function resolveVideoBackend(
  search: string,
  stored: string | null,
  probe: VideoCapabilities | null,
): ResolvedVideoBackend {
  const override = asBackend(new URLSearchParams(search).get('videoBackend'))
  const persisted = asBackend(stored)
  const source: ResolvedVideoBackend['source'] = override ? 'override' : persisted ? 'stored' : 'probe'
  const requested: VideoBackend = override ?? persisted ?? (probe?.server ? 'server' : 'wasm')

  const finish = (backend: VideoBackend, note: string | null): ResolvedVideoBackend => ({
    backend,
    executor: effectiveExecutor(backend, probe),
    source,
    note,
    probe,
  })

  if (requested === 'wasm' || requested === 'server') return finish(requested, null)

  // Explicit executor: needs the probe's word.
  const label = VIDEO_BACKEND_LABEL[requested]
  if (probe === null) {
    return finish('server', `${label} couldn't be verified (capability probe unavailable) — using Server (auto).`)
  }
  if (probe.executors.includes(requested)) return finish(requested, null)
  const fallback: VideoBackend = probe.server ? 'server' : 'wasm'
  return finish(
    fallback,
    `${label} isn't enabled on this instance — using ${VIDEO_BACKEND_LABEL[fallback]}.`,
  )
}

function effectiveExecutor(backend: VideoBackend, probe: VideoCapabilities | null): VideoExecutor | null {
  if (backend === 'wasm') return null
  if (backend === 'remote' || backend === 'local') return backend
  // server (auto): whatever CE will pick; unknown ⇒ assume local (cap 1 — conservative).
  return probe?.defaultExecutor ?? 'local'
}

// Cache the PROMISE, not the result (getFFmpeg pattern) — StrictMode double-mounts
// and concurrent op starts must share one probe.
let memo: Promise<ResolvedVideoBackend> | null = null
const listeners = new Set<() => void>()

function readSearch(): string {
  try {
    return window.location.search
  } catch {
    return '' // non-browser context (SSR/tests without window)
  }
}

export function getResolvedVideoBackend(): Promise<ResolvedVideoBackend> {
  if (memo) return memo
  memo = (async () => {
    const search = readSearch()
    let stored: string | null = null
    const override = asBackend(new URLSearchParams(search).get('videoBackend'))
    try {
      if (override) window.localStorage.setItem(STORAGE_KEY, override)
      stored = window.localStorage.getItem(STORAGE_KEY)
    } catch {
      /* no localStorage (SSR/tests) */
    }
    // A wasm decision needs nothing from the server — skip the network.
    if ((override ?? asBackend(stored)) === 'wasm') return resolveVideoBackend(search, stored, null)

    let probe: VideoCapabilities | null = null
    try {
      const res = await fetchWithReauth('/api/video/capabilities')
      if (res.ok) probe = parseCapabilities(await res.json())
    } catch {
      /* older CE / no rule / network: probe stays null */
    }
    return resolveVideoBackend(search, stored, probe)
  })()
  return memo
}

export function getVideoBackend(): Promise<VideoBackend> {
  return getResolvedVideoBackend().then((r) => r.backend)
}

/** Persist a new choice for this browser and re-resolve (the probe re-runs once). */
export function setVideoBackend(choice: VideoBackend): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    /* no localStorage */
  }
  memo = null
  for (const l of listeners) l()
}

export function subscribeVideoBackend(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetVideoBackendForTests(): void {
  memo = null
  listeners.clear()
}
```

Note on `setVideoBackend` + a URL override: after `setVideoBackend('remote')`, `getResolvedVideoBackend()` re-reads `window.location.search`; if the page URL still carries `?videoBackend=wasm` the override wins again. That is intended (the URL is the strongest signal, exactly like `?ffmpegCore=`); the picker (Task 7) disables itself while an override is present.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run src/lib/videoBackend.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Run the rest of the suite that touches the module and fix compile fallout**

Run: `pnpm exec vitest run src/components/Studio/useScenePipeline.videoBackend.test.tsx src/components/Studio/useAutoBuild.test.tsx src/store/studioApi.videoResult.test.ts`
Expected: PASS — `getVideoBackend()` still returns `'server'` for a stored `'server'`; the MSW probe mock returns `{server:false}` but `server` is honoured as-is. If `useScenePipeline.videoBackend.test.tsx` errors on an unhandled `/api/video/capabilities` request, it isn't — the handler exists in `src/mocks/handlers.ts` (`http.get('/api/video/capabilities', …)`).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm exec tsc -p tsconfig.app.json --noEmit && pnpm exec eslint src/lib/videoBackend.ts src/lib/videoBackend.test.ts
git add src/lib/videoBackend.ts src/lib/videoBackend.test.ts
git commit -m "feat(studio): widen the video backend resolver to wasm|server|local|remote with probe-validated executors"
```

---

### Task 2: Counted ffmpeg lane in `lib/autoBuild.ts`

**Files:**
- Modify: `apps/studio/src/lib/autoBuild.ts` (`STEP_LANE` doc, `nextActions` signature/body, new exports)
- Modify: `apps/studio/src/lib/autoBuild.test.ts` (extend `nextActions (lane scheduler)` describe)

**Interfaces:**
- Consumes: `VideoExecutor` from Task 1 (type-only import).
- Produces:
  ```ts
  export type Lane = 'ffmpeg' | 'refine' | 'sheets'
  export type LaneCaps = Record<Lane, number>
  export const DEFAULT_LANE_CAPS: LaneCaps   // { ffmpeg: 1, refine: 1, sheets: 1 }
  export const REMOTE_FFMPEG_MAX = 8
  export function ffmpegLaneCapacity(executor: VideoExecutor | null, sceneCount: number): number
  export function laneCapsFor(executor: VideoExecutor | null, sceneCount: number): LaneCaps
  export function nextActions(scenes: Scene[], inFlight: ActiveStep[], caps?: LaneCaps): AutoAction[]
  ```

- [ ] **Step 1: Add failing tests**

Append inside `describe('nextActions (lane scheduler)', …)` in `apps/studio/src/lib/autoBuild.test.ts` (reuse the file's existing scene fixtures/helpers — read the top of that describe first: it builds scenes at various steps and an `inFlight` list; mirror that style). Add a new `describe` block after it:

```ts
import { ffmpegLaneCapacity, laneCapsFor, DEFAULT_LANE_CAPS, REMOTE_FFMPEG_MAX } from './autoBuild'

describe('ffmpegLaneCapacity / laneCapsFor', () => {
  it('is 1 for wasm (null executor) and local', () => {
    expect(ffmpegLaneCapacity(null, 12)).toBe(1)
    expect(ffmpegLaneCapacity('local', 12)).toBe(1)
  })
  it('is min(8, scenes) for remote', () => {
    expect(ffmpegLaneCapacity('remote', 3)).toBe(3)
    expect(ffmpegLaneCapacity('remote', 12)).toBe(REMOTE_FFMPEG_MAX)
    expect(ffmpegLaneCapacity('remote', 0)).toBe(1) // never zero — a lone stitch/assemble must still run
  })
  it('leaves refine and sheets at 1', () => {
    expect(laneCapsFor('remote', 5)).toEqual({ ffmpeg: 5, refine: 1, sheets: 1 })
    expect(laneCapsFor(null, 5)).toEqual(DEFAULT_LANE_CAPS)
  })
})

describe('nextActions with a wider ffmpeg lane', () => {
  // Bare scenes: every one is on `cut` (ffmpeg lane).
  const bare = (id: string, index: number): Scene => ({
    id, index, sourceId: 'src', title: id, start: index * 10, end: index * 10 + 10, transcript: '', status: 'pending',
  })
  const scenes = [bare('a', 0), bare('b', 1), bare('c', 2), bare('d', 3)]

  it('cap 1 (default) still admits exactly one ffmpeg step', () => {
    const steps = nextActions(scenes, []).filter((a) => a.kind === 'step')
    expect(steps.map((a) => a.kind === 'step' && a.scene.id)).toEqual(['a'])
  })
  it('cap 3 admits three cuts across scenes and holds the fourth', () => {
    const caps = { ffmpeg: 3, refine: 1, sheets: 1 }
    const steps = nextActions(scenes, [], caps).filter((a) => a.kind === 'step')
    expect(steps.map((a) => a.kind === 'step' && a.scene.id)).toEqual(['a', 'b', 'c'])
  })
  it('counts in-flight ffmpeg steps against the cap', () => {
    const caps = { ffmpeg: 3, refine: 1, sheets: 1 }
    const inFlight = [{ sceneId: 'a', stepId: 'cut' as const }, { sceneId: 'b', stepId: 'cut' as const }]
    const steps = nextActions(scenes, inFlight, caps).filter((a) => a.kind === 'step')
    expect(steps.map((a) => a.kind === 'step' && a.scene.id)).toEqual(['c'])
  })
  it('cap min(8, scenes) admits every scene when there are fewer than 8', () => {
    const steps = nextActions(scenes, [], laneCapsFor('remote', scenes.length)).filter((a) => a.kind === 'step')
    expect(steps).toHaveLength(4)
  })
  it('a wider ffmpeg lane never widens refine or sheets', () => {
    // two scenes both on `sheets` (cut done): only one sheets step is admitted
    const cut = (s: Scene): Scene => ({ ...s, clipUrl: 'c.mp4', clipAudioUrl: 'c.wav' })
    const twoOnSheets = [cut(bare('a', 0)), cut(bare('b', 1))]
    const steps = nextActions(twoOnSheets, [], laneCapsFor('remote', 2)).filter((a) => a.kind === 'step')
    expect(steps.map((a) => a.kind === 'step' && a.step)).toEqual(['sheets'])
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm exec vitest run src/lib/autoBuild.test.ts`
Expected: FAIL (`ffmpegLaneCapacity` not exported; the cap-3 case yields one step).

- [ ] **Step 3: Implement**

In `apps/studio/src/lib/autoBuild.ts`:

1. Add `import type { VideoExecutor } from './videoBackend'` next to the existing imports.
2. Replace the `STEP_LANE` doc comment + declaration with:

```ts
export type Lane = 'ffmpeg' | 'refine' | 'sheets'

/**
 * Which shared resource each step occupies. cut + assemble both run ffmpeg —
 * on the wasm backend that's the ONE ffmpeg.wasm instance (the MT core already
 * saturates every core, with a fixed 3 GiB heap), and on CE's Local executor
 * it's the backend's single ffmpeg slot, so the lane holds capacity 1 there.
 * On the Remote executor each job is its own Cloud Run instance, so the lane
 * widens to `ffmpegLaneCapacity` (spec P6). refine is a server job the browser
 * merely polls; sheets is main-thread canvas capture — both stay at 1.
 */
export const STEP_LANE: Record<AutoStepId, Lane> = {
  cut: 'ffmpeg',
  assemble: 'ffmpeg',
  refine: 'refine',
  sheets: 'sheets',
}

/** How many steps each lane may hold at once. */
export type LaneCaps = Record<Lane, number>

export const DEFAULT_LANE_CAPS: LaneCaps = { ffmpeg: 1, refine: 1, sheets: 1 }

/** CE's remote in-flight fuse (FFMPEG_REMOTE_MAX_INFLIGHT default) — never ask for more than the server will take. */
export const REMOTE_FFMPEG_MAX = 8

/**
 * The ffmpeg lane's width for a run: wasm (null) and local are single-slot;
 * remote is min(8, scenes) — one job per scene is the most useful parallelism
 * and 8 is CE's fuse. Never below 1 so a lone assemble/stitch still runs.
 */
export function ffmpegLaneCapacity(executor: VideoExecutor | null, sceneCount: number): number {
  if (executor !== 'remote') return 1
  return Math.max(1, Math.min(REMOTE_FFMPEG_MAX, sceneCount))
}

export function laneCapsFor(executor: VideoExecutor | null, sceneCount: number): LaneCaps {
  return { ...DEFAULT_LANE_CAPS, ffmpeg: ffmpegLaneCapacity(executor, sceneCount) }
}
```

3. Change `nextActions`:

```ts
export function nextActions(
  scenes: Scene[],
  inFlight: ActiveStep[],
  caps: LaneCaps = DEFAULT_LANE_CAPS,
): AutoAction[] {
  const laneLoad: Record<Lane, number> = { ffmpeg: 0, refine: 0, sheets: 0 }
  for (const a of inFlight) if (a.stepId !== 'stitch') laneLoad[STEP_LANE[a.stepId]] += 1
  const busyScenes = new Set(inFlight.map((a) => a.sceneId))
  const actions: AutoAction[] = []
  let sceneWorkRemains = false

  for (const [i, sc] of scenes.entries()) {
    if (sc.status === 'built') continue
    sceneWorkRemains = true
    const step = nextStep(sc)
    if (step === null) {
      if (!busyScenes.has(sc.id)) actions.push({ kind: 'markBuilt', scene: sc })
      continue
    }
    if (busyScenes.has(sc.id)) continue
    if (step === 'refine' && !scenes.slice(0, i).every((p) => p.status === 'built' || !!p.refined))
      continue
    const lane = STEP_LANE[step]
    if (laneLoad[lane] >= caps[lane]) continue
    laneLoad[lane] += 1
    actions.push({ kind: 'step', scene: sc, step })
  }

  if (!sceneWorkRemains && inFlight.length === 0) actions.push({ kind: 'stitch' })
  return actions
}
```

Update the `nextActions` doc comment's lane bullet to: "its lane (see `STEP_LANE`) has a free slot under `caps` — counting both `inFlight` and steps admitted earlier in this same pass (earlier scene wins the slot),".

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run src/lib/autoBuild.test.ts src/store/studioSlice.autoBuild.test.ts`
Expected: PASS (existing cap-1 expectations unchanged).

- [ ] **Step 5: Commit**

```bash
pnpm exec eslint src/lib/autoBuild.ts src/lib/autoBuild.test.ts
git add src/lib/autoBuild.ts src/lib/autoBuild.test.ts
git commit -m "feat(studio): counted ffmpeg lane with a backend-dependent capacity for Auto Build"
```

---

### Task 3: Send `executor` on video jobs; widen the "server path" checks

**Files:**
- Modify: `apps/studio/src/store/studioApi.ts:118-135` (three mutation body types)
- Modify: `apps/studio/src/components/Studio/useScenePipeline.ts` (lines ~1090, ~1389, ~1687-1697, ~1731-1748)
- Modify: `apps/studio/src/components/Studio/useAutoBuild.ts:211,277`
- Modify: `apps/studio/src/components/Studio/SceneAssembleBar.tsx:98`, `FinalCutBar.tsx:83`
- Test: `apps/studio/src/components/Studio/useScenePipeline.videoBackend.test.tsx` (add cases)

**Interfaces:**
- Consumes: `getVideoBackend`, `stepExecutor` (Task 1).
- Produces: request bodies `{ …, executor?: 'local' | 'remote' }` on `/api/video/{extract-audio,slice,concat}`.

- [ ] **Step 1: Add failing tests**

In `useScenePipeline.videoBackend.test.tsx`, add a new `describe` after the existing one. It captures the slice request body via an MSW override that delegates to the real mock:

```ts
describe('sliceScene — executor in the request body', () => {
  async function capturedSliceBody(stored: string, probe: object) {
    window.localStorage.setItem('videoBackend', stored)
    let body: Record<string, unknown> | null = null
    server.use(
      http.get('/api/video/capabilities', () => HttpResponse.json(probe)),
      http.post('/api/video/slice', async ({ request }) => {
        body = (await request.clone().json()) as Record<string, unknown>
        // Hand back a job the mock poll endpoint knows nothing about → fail fast.
        return HttpResponse.json({ jobId: 'captured', status: 'pending' })
      }),
      http.get('/api/studio/job', () =>
        HttpResponse.json({ status: 'error', kind: 'video-slice', error: 'stop here' }),
      ),
    )
    const store = makeStore()
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )
    await cut()
    await waitFor(() => expect(body).not.toBeNull(), { timeout: 8000 })
    return body as Record<string, unknown>
  }
  const BOTH = { server: true, ops: ['slice'], version: null, executors: ['local', 'remote'], defaultExecutor: 'local', remote: { ready: true } }

  it('remote → executor:"remote"', async () => {
    expect((await capturedSliceBody('remote', BOTH)).executor).toBe('remote')
  }, 10000)
  it('local → executor:"local"', async () => {
    expect((await capturedSliceBody('local', BOTH)).executor).toBe('local')
  }, 10000)
  it('server (auto) → no executor field', async () => {
    expect('executor' in (await capturedSliceBody('server', BOTH))).toBe(false)
  }, 10000)
  it('remote that the instance lacks falls back to server (auto) → no executor field', async () => {
    const localOnly = { ...BOTH, executors: ['local'], remote: undefined }
    expect('executor' in (await capturedSliceBody('remote', localOnly))).toBe(false)
  }, 10000)
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm exec vitest run src/components/Studio/useScenePipeline.videoBackend.test.tsx`
Expected: the new cases FAIL (`executor` undefined for remote/local — the wasm branch is not taken because `getVideoBackend()` returns `'remote'` ≠ `'server'`, so with the current `=== 'server'` check the wasm path runs and no slice request is captured → `waitFor` times out).

- [ ] **Step 3: Implement**

`studioApi.ts` — add `executor?: 'local' | 'remote'` to the three body types:

```ts
    videoExtractStart: builder.mutation<StartJobResponse, { sourceUrl: string; projectId: string; executor?: 'local' | 'remote' }>({
      query: (body) => ({ url: 'api/video/extract-audio', method: 'POST', body }),
    }),
    videoSliceStart: builder.mutation<
      StartJobResponse,
      { sourceUrl: string; spans: { start: number; end: number }[]; wantAudio: boolean; audioFades: boolean; projectId: string; executor?: 'local' | 'remote' }
    >({ query: (body) => ({ url: 'api/video/slice', method: 'POST', body }) }),
    videoConcatStart: builder.mutation<StartJobResponse, { parts: string[]; projectId: string; executor?: 'local' | 'remote' }>({
      query: (body) => ({ url: 'api/video/concat', method: 'POST', body }),
    }),
```

`useScenePipeline.ts` — change the import to `import { getVideoBackend, stepExecutor } from '../../lib/videoBackend'` and, at each of the four server-path sites, replace `if ((await getVideoBackend()) === 'server') {` with:

```ts
        const backend = await getVideoBackend()
        if (backend !== 'wasm') {
```

and add `executor: stepExecutor(backend),` to the request body of `videoExtractStartReq` (~1096), `videoSliceStartReq` in `sliceScene` (~1393). For `stitchFinalCutRemote` and `assembleSceneRemote` (which are only called on a server path) prepend `const backend = await getVideoBackend()` and add `executor: stepExecutor(backend),` to their bodies. RTK's `fetchBaseQuery` JSON-serialises the body, so an `undefined` `executor` is dropped from the wire (`JSON.stringify` omits undefined properties) — the "no executor field" test relies on that.

`useAutoBuild.ts` (2 sites), `SceneAssembleBar.tsx`, `FinalCutBar.tsx` (1 site each): replace `(await getVideoBackend()) === 'server'` with `(await getVideoBackend()) !== 'wasm'`. Update the adjacent comments from "server backend" wording only where they say `'server'` literally.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run src/components/Studio/useScenePipeline.videoBackend.test.tsx src/components/Studio/useScenePipeline.serverExtract.test.tsx src/components/Studio/useScenePipeline.assembleStitch.test.tsx src/components/Studio/useAutoBuild.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm exec tsc -p tsconfig.app.json --noEmit && pnpm exec eslint src/store/studioApi.ts src/components/Studio/useScenePipeline.ts src/components/Studio/useAutoBuild.ts src/components/Studio/SceneAssembleBar.tsx src/components/Studio/FinalCutBar.tsx
git add -A src/store/studioApi.ts src/components/Studio/useScenePipeline.ts src/components/Studio/useScenePipeline.videoBackend.test.tsx src/components/Studio/useAutoBuild.ts src/components/Studio/SceneAssembleBar.tsx src/components/Studio/FinalCutBar.tsx
git commit -m "feat(studio): send the chosen executor on video jobs; any non-wasm backend takes the server path"
```

---

### Task 4: Rules — `executor` pass-through + forward-compatible error text

**Files:**
- Modify: `apps/studio/.bffless/proxy-rules/studio/rules/api/video/slice/post/{rule.yaml,prep.fn.js,check.fn.js,check.fn.test.yaml}`
- Modify: `apps/studio/.bffless/proxy-rules/studio/rules/api/video/extract-audio/post/{rule.yaml,prep.fn.js,check.fn.js,check.fn.test.yaml}`
- Modify: `apps/studio/.bffless/proxy-rules/studio/rules/api/video/concat/post/{rule.yaml,prep.fn.js,check.fn.js,check.fn.test.yaml}`

**Interfaces:**
- Consumes: body field `executor` (Task 3).
- Produces: `steps.prep.executor` (`'local' | 'remote' | ''`); job `error` strings of the form `Server slice failed (FFMPEG_BUSY: <message>)` once CE provides `stepErrors` (ce#662) — Task 5's classifier matches on that.

- [ ] **Step 1: Add failing fixture cases**

Append to `slice/post/check.fn.test.yaml`:

```yaml
  - name: a failed step's code + message are carried into the job error when CE exposes them (ce#662)
    data:
      steps: {}
      stepErrors:
        sliceWithAudio: { code: FFMPEG_BUSY, message: "remote in-flight limit reached (8)" }
      deployment: { owner: o, repo: r }
    expect:
      result:
        ok: false
        notOk: true
        error: "Server slice failed (FFMPEG_BUSY: remote in-flight limit reached (8))"
        data: null
  - name: the sliceOnly branch's error is read too
    data:
      steps: {}
      stepErrors:
        sliceOnly: { code: FFMPEG_EXECUTOR_UNAVAILABLE, message: "executor 'remote' is not enabled" }
      deployment: { owner: o, repo: r }
    expect:
      result:
        ok: false
        notOk: true
        error: "Server slice failed (FFMPEG_EXECUTOR_UNAVAILABLE: executor 'remote' is not enabled)"
        data: null
```

Append the analogous single case to `extract-audio/post/check.fn.test.yaml` (step name `extract`, prefix `Server audio extraction failed`) and `concat/post/check.fn.test.yaml` (step name `stitch`, prefix `Server stitch failed`). Read each existing yaml first and copy its `deployment` shape.

- [ ] **Step 2: Run the fixtures to see them fail**

Run: `cd .bffless/proxy-rules && npx bffless rules test studio; cd ../..`
Expected: the new cases FAIL (error text lacks the code).

- [ ] **Step 3: Implement the check functions**

Add one shared helper *inline in each file* (function_handler code is a single file; there is no shared module):

`slice/post/check.fn.js`:

```js
function handler({ steps, deployment, stepErrors }) {
  var out = (steps && (steps.sliceWithAudio || steps.sliceOnly)) || null
  var path = out && out.storage_path
  if (typeof path !== 'string' || !path) {
    // Forward-compatible with CE's `stepErrors.<step>` context root (ce#662): when it
    // exists, carry the failed step's code + message so the client can tell FFMPEG_BUSY
    // (transient — retry) from a real failure. On today's CE it's undefined and the
    // message stays exactly as before.
    var err = stepErrors && (stepErrors.sliceWithAudio || stepErrors.sliceOnly)
    var detail = err && (err.code || err.message) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return { ok: false, notOk: true, error: 'Server slice failed' + detail, data: null }
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

Apply the same `detail` block to `extract-audio/post/check.fn.js` (`stepErrors && stepErrors.extract`, prefix `'Server audio extraction failed'`) and `concat/post/check.fn.js` (`stepErrors && stepErrors.stitch`, prefix `'Server stitch failed'`), keeping the rest of each file byte-identical.

- [ ] **Step 4: Pass `executor` through the rules**

`prep.fn.js` in all three: whitelist the value. Slice — add to the returned object `executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : ''` (and the same one-liner in extract-audio and concat preps; in extract-audio the return becomes `{ input: …, projectId: …, executor: … }`).

`rule.yaml` in all three: under every `handler: ffmpeg_handler` step's `config:` (slice has TWO — `sliceWithAudio` and `sliceOnly`; extract-audio has `extract`; concat has `stitch`) add, directly after `operation:`:

```yaml
        # Which CE executor runs this job (CE >= 0.4.31: 'local' | 'remote'; template-evaluated).
        # Empty string ⇒ CE's configured default (its selector does `requested?.trim() || default`),
        # so clients that omit `executor` behave exactly as before. Older CE ignores the key.
        executor: "{{steps.prep.executor}}"
```

Also add one sentence to each rule's top-level `description:` — "Optional body `executor: 'local'|'remote'` forces the CE executor (Remote executor, CE >= 0.4.31); omitted ⇒ instance default."

- [ ] **Step 5: Run fixtures + rule validation**

Run: `cd .bffless/proxy-rules && npx bffless rules test studio && npx bffless rules validate studio; cd ../..`
Expected: all fixtures pass (12 + 4 new); validate exits 0. (If `validate` complains about the unknown `executor` key on `ffmpeg_handler`, the local CLI's schema predates CE 0.4.31 — note it and continue; the live CE accepts it.)

- [ ] **Step 6: Commit**

```bash
git add .bffless/proxy-rules/studio/rules/api/video
git commit -m "feat(studio): video rules pass the client's executor through and carry step error codes (ce#662-ready)"
```

---

### Task 5: BUSY-aware job retry — `lib/videoJobRetry.ts` + `runVideoJob`

**Files:**
- Create: `apps/studio/src/lib/videoJobRetry.ts`
- Create: `apps/studio/src/lib/videoJobRetry.test.ts`
- Modify: `apps/studio/src/components/Studio/useScenePipeline.ts` (the four `videoXStartReq(...).unwrap()` + `pollJob` pairs)

**Interfaces:**
- Produces:
  ```ts
  export const BUSY_RETRY_DELAYS_MS: readonly number[]   // [15_000, 30_000, 60_000]
  export function isTransientVideoJobError(message: string): boolean
  export function withBusyRetry<T>(attempt: () => Promise<T>, opts?: { delays?: readonly number[]; sleep?: (ms: number) => Promise<void>; onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void }): Promise<T>
  ```
- Consumes (in `useScenePipeline`): the existing `pollJob`, `toVideoResult`, `VIDEO_POLL_TIMEOUT_MS`, `delay`.

- [ ] **Step 1: Write the failing test**

`apps/studio/src/lib/videoJobRetry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { BUSY_RETRY_DELAYS_MS, isTransientVideoJobError, withBusyRetry } from './videoJobRetry'

describe('isTransientVideoJobError', () => {
  it('matches CE’s FFMPEG_BUSY code wherever it appears in the job error', () => {
    expect(isTransientVideoJobError('Server slice failed (FFMPEG_BUSY: remote in-flight limit reached (8))')).toBe(true)
    expect(isTransientVideoJobError('FFMPEG_BUSY')).toBe(true)
  })
  it('does not match other failures', () => {
    expect(isTransientVideoJobError('Server slice failed')).toBe(false)
    expect(isTransientVideoJobError('Server slice failed (FFMPEG_EXECUTOR_UNAVAILABLE: …)')).toBe(false)
    expect(isTransientVideoJobError('')).toBe(false)
  })
})

describe('withBusyRetry', () => {
  const busy = () => new Error('Server slice failed (FFMPEG_BUSY: fuse)')

  it('returns the first successful attempt without sleeping', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(withBusyRetry(async () => 'ok', { sleep })).resolves.toBe('ok')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries busy failures with the 15s → 30s → 60s ladder, then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const onRetry = vi.fn()
    const attempt = vi.fn().mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValue('ok')
    await expect(withBusyRetry(attempt, { sleep, onRetry })).resolves.toBe('ok')
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([15_000, 30_000])
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, delayMs: 15_000 })
  })

  it('gives up after 4 attempts total and rethrows the last busy error', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const attempt = vi.fn().mockRejectedValue(busy())
    await expect(withBusyRetry(attempt, { sleep })).rejects.toThrow(/FFMPEG_BUSY/)
    expect(attempt).toHaveBeenCalledTimes(BUSY_RETRY_DELAYS_MS.length + 1)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([15_000, 30_000, 60_000])
  })

  it('rethrows a non-transient error immediately', async () => {
    const sleep = vi.fn()
    const attempt = vi.fn().mockRejectedValue(new Error('Server slice failed'))
    await expect(withBusyRetry(attempt, { sleep })).rejects.toThrow('Server slice failed')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('exports the locked ladder', () => {
    expect([...BUSY_RETRY_DELAYS_MS]).toEqual([15_000, 30_000, 60_000])
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm exec vitest run src/lib/videoJobRetry.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`apps/studio/src/lib/videoJobRetry.ts`:

```ts
/**
 * Graceful degradation for CE's `FFMPEG_BUSY` (spec P7). The Remote executor
 * has an in-flight fuse (FFMPEG_REMOTE_MAX_INFLIGHT, default 8) and the Cloud
 * Run front door can answer 429/503 under a burst; both surface as a job whose
 * error carries `FFMPEG_BUSY`. That is a queue-full signal, not a failure —
 * so a video job that fails busy is re-enqueued after a backoff instead of
 * halting the run. Anything else rethrows untouched (no silent downgrade —
 * product decision 2026-08-12).
 *
 * The classifier is inert until CE exposes failed-step codes to the rules'
 * check functions (ce#662): until then job rows say only "Server slice failed"
 * and never match. The rules are already written to carry the code the day CE
 * provides it (see `.bffless/proxy-rules/studio/rules/api/video/*\/post/check.fn.js`).
 */

/** 4 attempts total: fail → 15 s → fail → 30 s → fail → 60 s → last try. */
export const BUSY_RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000]

export function isTransientVideoJobError(message: string): boolean {
  return /FFMPEG_BUSY/.test(message)
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function withBusyRetry<T>(
  attempt: () => Promise<T>,
  opts: {
    delays?: readonly number[]
    sleep?: (ms: number) => Promise<void>
    onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void
  } = {},
): Promise<T> {
  const delays = opts.delays ?? BUSY_RETRY_DELAYS_MS
  const sleep = opts.sleep ?? realSleep
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      if (i >= delays.length || !isTransientVideoJobError(error.message)) throw error
      const delayMs = delays[i]
      opts.onRetry?.({ attempt: i + 1, delayMs, error })
      await sleep(delayMs)
    }
  }
}
```

- [ ] **Step 4: Run to see it pass**

Run: `pnpm exec vitest run src/lib/videoJobRetry.test.ts` → PASS.

- [ ] **Step 5: Wire `runVideoJob` into `useScenePipeline.ts`**

Add the import `import { withBusyRetry } from '../../lib/videoJobRetry'` and, right after the `pollJob` `useCallback` (line ~455), add:

```ts
  /**
   * Start a video job and poll it to its coerced result, re-enqueueing on
   * FFMPEG_BUSY (spec P7 — the retry ladder lives in lib/videoJobRetry.ts). Every
   * server-side video op goes through here so manual and Auto Build paths degrade
   * the same way. Retries are logged; nothing in the UI halts.
   */
  const runVideoJob = useCallback(
    (label: string, start: () => Promise<StartJobResponse>): Promise<VideoResult> =>
      withBusyRetry(
        async () => {
          const { jobId } = await start()
          const job = await pollJob(jobId, { timeoutMs: VIDEO_POLL_TIMEOUT_MS })
          return toVideoResult(job.result)
        },
        {
          onRetry: ({ attempt, delayMs, error }) =>
            console.warn(`[studio] ${label}: server busy — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}): ${error.message}`),
        },
      ),
    [pollJob],
  )
```

(`StartJobResponse` and `VideoResult` are exported from `../../store/studioApi`; add them to that file's existing import line in `useScenePipeline.ts` if not already imported — check with `grep -n "from '../../store/studioApi'" src/components/Studio/useScenePipeline.ts`.)

Then replace the four start+poll+coerce sequences:

- extract (~1096–1098):
  ```ts
          const out = await runVideoJob('extract audio', () =>
            videoExtractStartReq({ sourceUrl: srcUrl, projectId: activeProjectId ?? '', executor: stepExecutor(backend) }).unwrap(),
          )
          aUrl = out.url
  ```
- `sliceScene` (~1393–1398): `const out = await runVideoJob('cut scene', () => videoSliceStartReq({ …same body… }).unwrap())` and keep the `if (!out.audioUrl) throw …` line.
- `stitchFinalCutRemote`: `const out = await runVideoJob('stitch final cut', () => videoConcatStartReq({ … }).unwrap())`.
- `assembleSceneRemote`: `const out = await runVideoJob('assemble scene', () => videoSliceStartReq({ … }).unwrap())`.

Add `runVideoJob` to each of those callbacks' dependency arrays (replacing `pollJob` where it was only used for this).

- [ ] **Step 6: Add one hook-level test for the retry**

Append to `useScenePipeline.videoBackend.test.tsx`:

```ts
describe('sliceScene — FFMPEG_BUSY is retried, not surfaced', () => {
  it('re-enqueues after a busy job error and lands the second job', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      window.localStorage.setItem('videoBackend', 'server')
      let starts = 0
      server.use(
        http.post('/api/video/slice', () => {
          starts += 1
          return HttpResponse.json({ jobId: `job-${starts}`, status: 'pending' })
        }),
        http.get('/api/studio/job', ({ request }) => {
          const id = new URL(request.url).searchParams.get('id')
          if (id === 'job-1')
            return HttpResponse.json({ status: 'error', kind: 'video-slice', error: 'Server slice failed (FFMPEG_BUSY: fuse)' })
          return HttpResponse.json({
            status: 'done', kind: 'video-slice',
            result: { url: '/api/uploads/projects/p1/scene-clip/server/x.mp4', audioUrl: '/api/uploads/projects/p1/audio/server/x.wav' },
          })
        }),
      )
      const store = makeStore()
      render(<Provider store={store}><Harness /></Provider>)
      await cut()
      // first job → busy → 15 s backoff → second job → done
      await vi.advanceTimersByTimeAsync(20_000)
      await waitFor(() => expect(sceneOf(store)?.clipUrl).toMatch(/x\.mp4$/), { timeout: 8000 })
      expect(starts).toBe(2)
      expect(screen.getByTestId('error').textContent).toBe('')
    } finally {
      vi.useRealTimers()
    }
  }, 15000)
})
```

If fake timers fight MSW/RTK in this file (hangs), fall back to real timers by exporting the ladder through an injectable seam: give `runVideoJob` a module-level `let busyRetryDelays = BUSY_RETRY_DELAYS_MS` with `export function setBusyRetryDelaysForTests(d: number[])` in `useScenePipeline.ts`, set it to `[10]` in the test, and drop the fake timers. Prefer the fake-timer version; use the seam only if needed and say so in the commit body.

- [ ] **Step 7: Run + commit**

Run: `pnpm exec vitest run src/lib/videoJobRetry.test.ts src/components/Studio/useScenePipeline.videoBackend.test.tsx src/components/Studio/useScenePipeline.serverExtract.test.tsx src/components/Studio/useScenePipeline.assembleStitch.test.tsx` → PASS.

```bash
pnpm exec tsc -p tsconfig.app.json --noEmit && pnpm exec eslint src/lib/videoJobRetry.ts src/lib/videoJobRetry.test.ts src/components/Studio/useScenePipeline.ts src/components/Studio/useScenePipeline.videoBackend.test.tsx
git add src/lib/videoJobRetry.ts src/lib/videoJobRetry.test.ts src/components/Studio/useScenePipeline.ts src/components/Studio/useScenePipeline.videoBackend.test.tsx
git commit -m "feat(studio): retry video jobs that fail FFMPEG_BUSY with a 15s/30s/60s ladder"
```

---

### Task 6: Auto Build decides the lane cap once per Start/Resume

**Files:**
- Modify: `apps/studio/src/components/Studio/useAutoBuild.ts` (imports, `start`/`resume`, `capsRef`, `nextActions` call, module doc + `renderRef` comment)
- Modify: `apps/studio/src/components/Studio/useAutoBuild.test.tsx` (mock + 2 new tests)

**Interfaces:**
- Consumes: `getResolvedVideoBackend`, `getVideoBackend` (Task 1); `laneCapsFor`, `DEFAULT_LANE_CAPS`, `LaneCaps`, `nextActions(scenes, inFlight, caps)` (Task 2).
- Produces: `AutoBuildControls.start/resume` are now `() => Promise<void>` (callers may still `void` them).

- [ ] **Step 1: Update the module mock and add failing tests**

In `useAutoBuild.test.tsx` change the videoBackend mock so both exports exist and agree:

```ts
const { getVideoBackendMock, getResolvedVideoBackendMock } = vi.hoisted(() => ({
  getVideoBackendMock: vi.fn(),
  getResolvedVideoBackendMock: vi.fn(),
}))
vi.mock('../../lib/videoBackend', () => ({
  getVideoBackend: getVideoBackendMock,
  getResolvedVideoBackend: getResolvedVideoBackendMock,
}))
```

and in the top-level `beforeEach` (line ~179) after `getVideoBackendMock.mockResolvedValue('wasm')` add a helper used everywhere:

```ts
/** Point both mocks at one backend (the hook reads the resolved shape at Start). */
function backend(b: 'wasm' | 'server' | 'remote', executor: 'local' | 'remote' | null = b === 'remote' ? 'remote' : b === 'server' ? 'local' : null) {
  getVideoBackendMock.mockResolvedValue(b)
  getResolvedVideoBackendMock.mockResolvedValue({ backend: b, executor, source: 'stored', note: null, probe: null })
}
```

Call `backend('wasm')` in `beforeEach` and replace each existing `getVideoBackendMock.mockResolvedValue('server')` with `backend('server')`.

Add tests (in the existing top-level describe, after `'never runs two ffmpeg-lane steps at once'`):

```ts
  it('remote backend: cuts several scenes at once (cap = min(8, scenes))', async () => {
    backend('remote')
    const bare = (id: string, i: number): Scene => ({ ...prepped(id, i), clipUrl: undefined, clipAudioUrl: undefined, sheets: undefined, refined: undefined })
    const store = makeStore([bare('a', 0), bare('b', 1), bare('c', 2)])
    let inFlight = 0
    let peak = 0
    const gate: Array<() => void> = []
    const sliceScene = (id: string) =>
      new Promise<void>((resolve) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        gate.push(() => {
          inFlight -= 1
          store.dispatch(patchScene({ id, patch: { clipUrl: `${id}.mp4`, clipAudioUrl: `${id}.wav` } }))
          resolve()
        })
      })
    render(<Provider store={store}><Harness upload={vi.fn()} sliceScene={sliceScene} /></Provider>)
    await click('start')
    await waitFor(() => expect(peak).toBe(3))
    await act(async () => { gate.splice(0).forEach((g) => g()) })
    await waitFor(() => expect(scenesOf(store).every((s) => !!s.clipUrl)).toBe(true))
  })

  it('local (server) backend keeps the ffmpeg lane at 1', async () => {
    backend('server', 'local')
    const bare = (id: string, i: number): Scene => ({ ...prepped(id, i), clipUrl: undefined, clipAudioUrl: undefined, sheets: undefined, refined: undefined })
    const store = makeStore([bare('a', 0), bare('b', 1), bare('c', 2)])
    let peak = 0
    let inFlight = 0
    const sliceScene = (id: string) =>
      new Promise<void>((resolve) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        setTimeout(() => {
          inFlight -= 1
          store.dispatch(patchScene({ id, patch: { clipUrl: `${id}.mp4`, clipAudioUrl: `${id}.wav` } }))
          resolve()
        }, 5)
      })
    render(<Provider store={store}><Harness upload={vi.fn()} sliceScene={sliceScene} /></Provider>)
    await click('start')
    await waitFor(() => expect(scenesOf(store).every((s) => !!s.clipUrl)).toBe(true))
    expect(peak).toBe(1)
  })
```

(Read the file's `Harness` — `sliceScene` is already a prop; `prepped`/`makeStore`/`scenesOf`/`click` exist.)

- [ ] **Step 2: Run to see the new tests fail**

Run: `pnpm exec vitest run src/components/Studio/useAutoBuild.test.tsx`
Expected: the remote test FAILS (peak stays 1); the local one passes already.

- [ ] **Step 3: Implement**

In `useAutoBuild.ts`:

1. Imports: `import { getVideoBackend, getResolvedVideoBackend } from '../../lib/videoBackend'` and add `laneCapsFor, DEFAULT_LANE_CAPS, type LaneCaps` to the `../../lib/autoBuild` import.
2. After `liveRef`, add:

```ts
  // The lane widths for THIS run, decided once at Start/Resume from the resolved
  // video backend (spec P6): the ffmpeg lane is 1 on wasm/local and min(8, scenes)
  // on remote. Read by every `nextActions` pass; a picker change mid-run takes
  // effect on the next Resume, never mid-flight.
  const capsRef = useRef<LaneCaps>(DEFAULT_LANE_CAPS)
```

3. Replace `start`/`resume`:

```ts
  const decideCaps = useCallback(async () => {
    const resolved = await getResolvedVideoBackend()
    capsRef.current = laneCapsFor(resolved.executor, pipeRef.current.scenes.length)
  }, [])
  const start = useCallback(async () => {
    await decideCaps()
    liveRef.current = true
    dispatch(startAutoBuild())
  }, [dispatch, decideCaps])
  const resume = useCallback(async () => {
    await decideCaps()
    liveRef.current = true
    dispatch(resumeAutoBuild())
  }, [dispatch, decideCaps])
```

(`pipeRef` is declared later in the file — move the `pipeRef` declaration + its `useLayoutEffect` above these callbacks; the ref object itself is stable so reading `pipeRef.current` inside the async callback is fine.)

4. `AutoBuildControls`: `start: () => Promise<void>`, `resume: () => Promise<void>`.
5. The runner: `const actions = nextActions(p.scenes, [...inFlightRef.current.values()], capsRef.current)`.
6. Module doc: change "cut/assemble share the single ffmpeg.wasm instance" to "cut/assemble share the ffmpeg lane, whose width is decided once per Start/Resume from the resolved video backend — 1 on wasm/local, min(8, scenes) on remote". `renderRef` comment: replace "assemble sits in the ffmpeg lane (capacity 1), so at most one scene is ever rendering" with "the wasm assemble path is the only one that renders a blob here, and on wasm the ffmpeg lane is 1, so at most one scene is ever rendering (remote/local assemble is one server job with no blob)".
7. `Studio.tsx` passes `auto.start`/`auto.resume` to `AutoBuildBoard`, whose props are `() => void` — a `() => Promise<void>` is assignable; no change needed. If TS complains, wrap: `onStart={() => void auto.start()}`.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run src/components/Studio/useAutoBuild.test.tsx src/components/Studio/AutoBuildBoard.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec tsc -p tsconfig.app.json --noEmit && pnpm exec eslint src/components/Studio/useAutoBuild.ts src/components/Studio/useAutoBuild.test.tsx
git add src/components/Studio/useAutoBuild.ts src/components/Studio/useAutoBuild.test.tsx
git commit -m "feat(studio): Auto Build widens the ffmpeg lane to min(8, scenes) on the remote executor, decided once per run"
```

---

### Task 7: `VideoBackendPicker` on the Auto Build board + prep card; richer probe mock

**Files:**
- Create: `apps/studio/src/components/Studio/VideoBackendPicker.tsx`
- Create: `apps/studio/src/components/Studio/VideoBackendPicker.test.tsx`
- Modify: `apps/studio/src/components/Studio/AutoBuildBoard.tsx` (optional `toolbar?: ReactNode` prop rendered in the header)
- Modify: `apps/studio/src/pages/Studio.tsx` (~line 495 prep column, ~659 board)
- Modify: `apps/studio/src/mocks/handlers.ts:75-90, 262-268`

**Interfaces:**
- Consumes: Task 1's `getResolvedVideoBackend`, `setVideoBackend`, `subscribeVideoBackend`, `VIDEO_BACKEND_LABEL`, `ResolvedVideoBackend`, `VideoBackend`; Task 2's `ffmpegLaneCapacity`.
- Produces: `<VideoBackendPicker sceneCount={n} compact? />`; `AutoBuildBoard` prop `toolbar?: ReactNode`; mock `setMockVideoServerCapability(on: boolean, executors?: ('local'|'remote')[])`.

- [ ] **Step 1: Write the failing component test**

`VideoBackendPicker.test.tsx`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { resetVideoBackendForTests } from '../../lib/videoBackend'
import { VideoBackendPicker } from './VideoBackendPicker'

const probe = (caps: object) => vi.fn().mockResolvedValue(new Response(JSON.stringify(caps)))

beforeEach(() => {
  window.localStorage.clear()
  resetVideoBackendForTests()
})
afterEach(() => vi.unstubAllGlobals())

describe('VideoBackendPicker', () => {
  it('shows the active backend and disables executors the instance lacks', async () => {
    vi.stubGlobal('fetch', probe({ server: true, executors: ['local'], defaultExecutor: 'local' }))
    render(<VideoBackendPicker sceneCount={4} />)
    const select = (await screen.findByLabelText('Video backend')) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('server'))
    expect((screen.getByRole('option', { name: 'Remote' }) as HTMLOptionElement).disabled).toBe(true)
    expect((screen.getByRole('option', { name: 'Local server' }) as HTMLOptionElement).disabled).toBe(false)
    expect(screen.getByTestId('video-backend-status').textContent).toMatch(/Server \(auto\) · local/)
  })

  it('remote shows the parallelism and switching persists', async () => {
    vi.stubGlobal('fetch', probe({ server: true, executors: ['local', 'remote'], defaultExecutor: 'local', remote: { ready: true } }))
    render(<VideoBackendPicker sceneCount={12} />)
    const select = (await screen.findByLabelText('Video backend')) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('server'))
    fireEvent.change(select, { target: { value: 'remote' } })
    await waitFor(() => expect(select.value).toBe('remote'))
    expect(window.localStorage.getItem('videoBackend')).toBe('remote')
    expect(screen.getByTestId('video-backend-status').textContent).toMatch(/up to 8 parallel/)
  })

  it('surfaces the fallback note when a stored choice cannot be honoured', async () => {
    window.localStorage.setItem('videoBackend', 'remote')
    vi.stubGlobal('fetch', probe({ server: true, executors: ['local'], defaultExecutor: 'local' }))
    render(<VideoBackendPicker sceneCount={2} />)
    await screen.findByText(/Remote isn't enabled on this instance/)
    expect(((await screen.findByLabelText('Video backend')) as HTMLSelectElement).value).toBe('server')
  })

  it('offers only Browser when the instance has no server ops', async () => {
    vi.stubGlobal('fetch', probe({ server: false, ops: [], version: null }))
    render(<VideoBackendPicker sceneCount={2} />)
    const select = (await screen.findByLabelText('Video backend')) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('wasm'))
    for (const name of ['Server (auto)', 'Local server', 'Remote'])
      expect((screen.getByRole('option', { name }) as HTMLOptionElement).disabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run to see it fail** — `pnpm exec vitest run src/components/Studio/VideoBackendPicker.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement the component**

`VideoBackendPicker.tsx`:

```tsx
import { useEffect, useState, type ReactNode } from 'react'
import {
  getResolvedVideoBackend,
  setVideoBackend,
  subscribeVideoBackend,
  VIDEO_BACKEND_LABEL,
  type ResolvedVideoBackend,
  type VideoBackend,
} from '../../lib/videoBackend'
import { ffmpegLaneCapacity } from '../../lib/autoBuild'

const ORDER: VideoBackend[] = ['wasm', 'server', 'local', 'remote']

/**
 * Where video ops run this session (spec P8): a compact select over Browser /
 * Server (auto) / Local server / Remote plus a one-line status — the honoured
 * backend, its effective executor, the Auto Build parallelism it buys, and the
 * fallback note when a choice couldn't be honoured. Choices persist per browser
 * (`localStorage.videoBackend`, same key as the `?videoBackend=` override); a
 * change re-resolves in-session, and Auto Build reads the new lane width on its
 * next Start/Resume. Rendered on the Auto Build board and the prep card.
 */
export function VideoBackendPicker({ sceneCount, compact = false }: { sceneCount: number; compact?: boolean }) {
  const [resolved, setResolved] = useState<ResolvedVideoBackend | null>(null)

  useEffect(() => {
    let live = true
    const load = () => {
      setResolved(null)
      void getResolvedVideoBackend().then((r) => {
        if (live) setResolved(r)
      })
    }
    load()
    const unsub = subscribeVideoBackend(load)
    return () => {
      live = false
      unsub()
    }
  }, [])

  const probe = resolved?.probe ?? null
  const overridden = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('videoBackend')
  const enabled = (b: VideoBackend): boolean => {
    if (b === 'wasm') return true
    if (probe === null) return b === 'server' // unverifiable: only the auto choice is offered
    if (!probe.server) return false
    if (b === 'server') return true
    return probe.executors.includes(b)
  }

  let status: ReactNode = 'Checking video backend…'
  if (resolved) {
    const parts = [VIDEO_BACKEND_LABEL[resolved.backend]]
    if (resolved.executor) parts.push(resolved.executor)
    if (resolved.executor === 'remote') parts.push(`up to ${ffmpegLaneCapacity('remote', sceneCount)} parallel`)
    status = parts.join(' · ')
  }

  return (
    <div className={compact ? 'flex flex-wrap items-center gap-2 text-[12px]' : 'flex flex-col gap-1 text-[12px]'} data-testid="video-backend-picker">
      <label className="flex items-center gap-2 text-ink-soft">
        <span className="meta-label">Video backend</span>
        <select
          aria-label="Video backend"
          className="rounded border border-rule bg-surface px-2 py-1 text-[12px] text-ink"
          value={resolved?.backend ?? 'wasm'}
          disabled={!resolved || overridden}
          onChange={(e) => setVideoBackend(e.target.value as VideoBackend)}
        >
          {ORDER.map((b) => (
            <option key={b} value={b} disabled={!enabled(b)}>
              {VIDEO_BACKEND_LABEL[b]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-ink-soft" data-testid="video-backend-status">
        {status}
        {overridden ? ' · set by ?videoBackend= in the URL' : ''}
      </p>
      {resolved?.note ? (
        <p className="text-amber-700 dark:text-amber-400" role="status">
          {resolved.note}
        </p>
      ) : null}
    </div>
  )
}
```

Check the class names against `apps/studio/src/index.css` / `DESIGN.md` (`meta-label`, `text-ink-soft`, `border-rule`, `bg-surface` are used across the Studio components — grep before inventing new tokens; adjust to existing utility names if any differ).

- [ ] **Step 4: Run the component test** → PASS.

- [ ] **Step 5: Mount it**

`AutoBuildBoard.tsx`: add `toolbar?: ReactNode` to `Props` (import `type ReactNode` from react) and render it inside the header's right-hand `div` before the Start button: `{toolbar}`. Existing `AutoBuildBoard.test.tsx` doesn't pass it — no change needed.

`Studio.tsx`: import `VideoBackendPicker`; pass `toolbar={<VideoBackendPicker sceneCount={pipe.scenes.length} compact />}` to `<AutoBuildBoard …/>` (~line 659); in the prep column (~line 495, inside the `inPrep` block just above `<SourceQueue …>`), render `<VideoBackendPicker sceneCount={Math.max(1, pipe.scenes.length)} compact />` wrapped in the same `border rule bg-surface p-4` container style the neighbouring cards use (copy the wrapper class from `SourceQueue`'s parent or `StageCard`).

- [ ] **Step 6: Mock probe reports executors**

`src/mocks/handlers.ts`: change the knob to

```ts
let mockVideoServer = false
let mockVideoExecutors: Array<'local' | 'remote'> = ['local']
export function setMockVideoServerCapability(on: boolean, executors: Array<'local' | 'remote'> = ['local']): void {
  mockVideoServer = on
  mockVideoExecutors = executors
}
```

and the handler to

```ts
  http.get('/api/video/capabilities', () =>
    HttpResponse.json(
      mockVideoServer
        ? {
            server: true, ops: ['probe', 'extract_audio', 'slice', 'concat'], version: 'ffmpeg 7.0-mock',
            executors: mockVideoExecutors, defaultExecutor: mockVideoExecutors[0] ?? 'local',
            ...(mockVideoExecutors.includes('remote') ? { remote: { ready: true, version: 'mock' } } : {}),
          }
        : { server: false, ops: [], version: null, executors: [], defaultExecutor: 'local' },
    ),
  ),
```

Extend the knob's doc comment with one line: "`executors` lets the picker be demoed offline (`setMockVideoServerCapability(true, ['local','remote'])`)". Check `grep -rn setMockVideoServerCapability src` for callers — the extra parameter is optional so none break.

- [ ] **Step 7: Full suite, typecheck, lint, commit**

Run: `pnpm test:run` → all green. `pnpm exec tsc -p tsconfig.app.json --noEmit && pnpm exec eslint src/components/Studio/VideoBackendPicker.tsx src/components/Studio/VideoBackendPicker.test.tsx src/components/Studio/AutoBuildBoard.tsx src/pages/Studio.tsx src/mocks/handlers.ts`

```bash
git add src/components/Studio/VideoBackendPicker.tsx src/components/Studio/VideoBackendPicker.test.tsx src/components/Studio/AutoBuildBoard.tsx src/pages/Studio.tsx src/mocks/handlers.ts
git commit -m "feat(studio): video backend picker on the Auto Build board and prep card"
```

- [ ] **Step 8: Visual check (headless)**

From `apps/studio`: `VITE_MOCK_STUDIO=true pnpm dev --port 5173 &` then `cd /home/rico/bffless/localdev-tools && node shot.mjs "http://localhost:5173/?mocks=on" --out /tmp/claude-1000/-home-rico-bffless/cc64d503-40a7-48e8-b5d6-ac3e2e42b3f6/scratchpad/picker.png --full` — confirm the picker renders on the prep card and there are 0 console errors; kill the dev server afterwards (`kill %1`). If the mock route needs a project to reach the prep card, note the URL used in the commit/report; do not spend more than a few minutes here.

---

### Task 8: Docs — CLAUDE.md, README, catalog, CONTEXT glossary

**Files:**
- Modify: `apps/studio/CLAUDE.md:40-42`
- Modify: `apps/studio/README.md` (the ffmpeg.wasm sentence near line 6 and the prerequisites table near line 20)
- Modify: `apps/studio/catalog/description.md:15`
- Modify: `apps/studio/CONTEXT.md` (`## Language`)

- [ ] **Step 1: CLAUDE.md** — replace the "Server-side video ops" paragraph with:

> Server-side video ops (`/api/video/{capabilities,slice,concat,extract-audio}`, CE's `ffmpeg_handler`) unlock on CE ≥ 0.4.25; the client probes once per session and falls back to `ffmpeg.wasm` on older CE. On CE ≥ 0.4.31 the probe also lists `executors` (`local` = ffmpeg in the backend, `remote` = the Cloud Run Worker) and the picker on the Auto Build board / prep card chooses **Browser | Server (auto) | Local server | Remote** (`src/lib/videoBackend.ts`; `?videoBackend=wasm|server|local|remote` override, persisted). Explicit choices send `executor` on the job body (the video rules pass it through); Auto Build widens its ffmpeg lane to `min(8, scenes)` on Remote (`src/lib/autoBuild.ts`), and `FFMPEG_BUSY` job errors are retried (`src/lib/videoJobRetry.ts`; needs ce#662 for the code to reach the job row).

- [ ] **Step 2: README.md** — after the sentence that says export runs in your browser with ffmpeg.wasm, add: "On a CE ≥ 0.4.31 instance with server video ops enabled, cut/assemble/stitch can instead run on the server — locally in the backend or on the Remote executor (Cloud Run) — and Auto Build runs up to 8 scenes in parallel on Remote. Pick it from the **Video backend** control on the Auto Build board." Add a row to the prerequisites table: `| Server video ops (optional) | Admin Settings → Features → Server video ops (Local and/or Remote executor) | No | Moves ffmpeg off the browser; Remote parallelises Auto Build (see docs.bffless.dev → Features → Server video ops) |`.

- [ ] **Step 3: catalog/description.md** — change item 4 to: "**Export** stitches the final cut — in your browser with ffmpeg.wasm by default, or on your BFFless server (Local or Remote executor) when the instance offers it, with parallel scene builds on Remote."

- [ ] **Step 4: CONTEXT.md** — add to `## Language`, following the existing entry format:

```
**Video backend**:
Where Studio's ffmpeg work runs this session: **Browser** (ffmpeg.wasm in the tab), **Server
(auto)** (CE's `ffmpeg_handler`, CE picks its default executor), **Local server** (CE, forcing
the Local executor) or **Remote** (CE, forcing the Remote executor — a Cloud Run Worker). Chosen
per browser (`?videoBackend=` / localStorage), validated against the capability probe's
`executors`; only Remote widens Auto Build's ffmpeg lane (min(8, scenes)).
_Avoid_: "wasm mode" / "server mode" as user-facing labels
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md catalog/description.md CONTEXT.md
git commit -m "docs(studio): document the video backend picker, executors and parallel Auto Build"
```

---

## Self-review (done while writing)

- **Spec coverage:** P1/P2/P3/P4 → Task 1; P5 → Tasks 3+4; P6 → Tasks 2+6; P7 → Tasks 4+5; P8 → Task 7 (+ mock); P9 out of scope; docs → Task 8. Deliverable (5) tests are inside each task; (6) is Task 8.
- **Types:** `VideoExecutor`, `ResolvedVideoBackend`, `LaneCaps`, `laneCapsFor(executor, sceneCount)`, `stepExecutor`, `withBusyRetry`, `runVideoJob(label, start)` — used with the same names/signatures across tasks.
- **Fallout to watch:** the `useAutoBuild.test.tsx` module mock must export `getResolvedVideoBackend` (Task 6 Step 1) — until Task 6 that file still passes because Task 3 only uses `getVideoBackend` there.
