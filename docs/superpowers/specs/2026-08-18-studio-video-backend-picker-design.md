# Studio video backend picker + parallel Auto Build (ffmpeg Remote executor, Plan 3) — Design

- **Date:** 2026-08-18
- **Status:** decisions locked with the user (2026-08-17 grilling + 2026-08-18 brainstorm); ready to plan
- **Repo:** `bffless/apps` → `apps/studio` · **Epic:** bffless/apps#346
- **Upstream spec:** `bffless/ce` `docs/superpowers/specs/2026-08-17-ffmpeg-remote-executor-design.md` (Part 2 + D6). CE Plans 1+2 are merged (ce#684/#685/#686) and verified live on bffless.dev (`:preview`).

## What CE gives us (as built, verified live)

`GET /api/video/capabilities` (Studio's own probe rule, session-gated) returns

```jsonc
{ "server": true, "ops": [...], "version": null,
  "executors": ["local" | "remote", ...], "defaultExecutor": "remote",
  "remote": { "ready": true, "version": "…", "reason": "…" } }
```

`ffmpeg_handler` steps accept an optional, **template-evaluated** `executor` config. CE's selector does
`requested?.trim() || defaultExecutor`, so a rule that passes `executor: "{{request.body.executor}}"`
is safe when the client omits the field (empty string ⇒ instance default). Unknown / disabled / not-ready
executors fail the step with `FFMPEG_EXECUTOR_UNAVAILABLE`. Concurrency: CE's in-flight fuse
`FFMPEG_REMOTE_MAX_INFLIGHT` (default 8) → `FFMPEG_BUSY`; the reference Cloud Run deploy runs
`--max-instances 10 --concurrency 1`.

**Known gap:** a failed postStep's `{code, message}` is not visible to later steps (ce#662 OPEN), so
Studio's `check.fn.js` can only write "Server slice failed" into the job row — `FFMPEG_BUSY` is
indistinguishable from any other failure today.

## Locked decisions

| # | Decision | Choice |
| --- | --- | --- |
| P1 | Choice model | `VideoBackend = 'wasm' \| 'server' \| 'local' \| 'remote'`. `wasm` = in-browser (labelled **Browser**; `browser` accepted as a URL/label alias). `server` = **Server (auto)** — CE picks its default, steps send no `executor`. `local` = **Local server** (steps send `executor: 'local'`). `remote` = **Remote** (steps send `executor: 'remote'`). |
| P2 | Resolution order | `?videoBackend=` override (persisted to `localStorage.videoBackend`, as today) → stored choice → probe (`server:true` ⇒ `'server'`, else `'wasm'`). **The probe now always runs once per session for any server-side choice** (`server`/`local`/`remote`, even when stored/overridden; a `wasm` choice skips the network) so it can validate the choice and supply `defaultExecutor`. |
| P3 | Honouring | `remote` / `local` are honoured **only when `probe.executors` includes them**; otherwise fall back to `server` when `probe.server` is true, else `wasm`, with a visible note ("Remote isn't enabled on this instance — using Server (auto)"). If the probe fails entirely (older CE, no rule, network), `executors` is treated as unknown ⇒ `remote`/`local` fall back to `server` (with note); `server`/`wasm` are always honoured as-is — even against a probe that disagrees — exactly as today's `?videoBackend=server` testing override. |
| P4 | Resolved shape | `getVideoBackend()` keeps returning `Promise<VideoBackend>` (call sites compare `!== 'wasm'` for "any server path" — today's `=== 'server'` checks widen). New `getResolvedVideoBackend()` returns `{ backend, executor: 'local' \| 'remote' \| null, source: 'override' \| 'stored' \| 'probe', note: string \| null, probe }` where `executor` is the *effective* executor: `remote`→`remote`, `local`→`local`, `server`→`probe.defaultExecutor ?? 'local'`, `wasm`→`null`. |
| P5 | Step config | `videoExtractStart` / `videoSliceStart` / `videoConcatStart` bodies gain optional `executor?: 'local' \| 'remote'`; a shared `stepExecutor(backend)` helper (`'remote'`→`'remote'`, `'local'`→`'local'`, else `undefined`) is applied at every call site. The four ffmpeg steps in the three rules pass `executor: "{{request.body.executor}}"`; `prep.fn.js` whitelists the value (`local`/`remote`, else `''`). |
| P6 | Auto Build capacity | `nextActions(scenes, inFlight, caps?)` — lanes become counted (`{ ffmpeg: n }`, default `{ ffmpeg: 1 }`; refine/sheets stay 1). `ffmpegLaneCapacity(resolved, sceneCount)`: `wasm`=1, `local`=1, `remote`=`min(8, sceneCount)`. The runner resolves it **once per Start/Resume** (`start`/`resume` await `getResolvedVideoBackend()` then store `capsRef` and dispatch) — switching the picker mid-run takes effect on the next Resume. |
| P7 | BUSY degradation | Job-level retry in `useScenePipeline`: a `runVideoJob(start, body)` helper wraps start+poll and, when the job error is *transient* (`isTransientVideoJobError`: `/FFMPEG_BUSY/`), retries the whole job with backoff **15 s → 30 s → 60 s (4 attempts total)** before rethrowing. `check.fn.js` in the three rules becomes forward-compatible: when `stepErrors.<step>` exists (ce#662) the job error is written as `"Server slice failed (FFMPEG_BUSY: …)"`, which lights the classifier up with no further apps change. Until ce#662 lands the classifier is inert; the cap ≤ fuse (8) keeps a single tab from tripping the fuse. Retries are logged (`console.warn`) and never surface as a halt. |
| P8 | UI | One `VideoBackendPicker` component (compact `<select>` Browser / Server (auto) / Local server / Remote, disabled options for executors the probe doesn't list, a one-line status: active backend + effective executor + "up to N parallel" for remote + fallback note). Rendered in the **AutoBuildBoard header** and in the **prep card** (`Studio.tsx` next to `MediaImport`/`SourceQueue`). Choosing persists to `localStorage.videoBackend` and re-resolves in-session (memo reset). |
| P9 | Out of scope | Persisting `executor`/`timings.totalMs` into `studio_jobs` rows + job list display (spec Part 2 bullet 3) — separate follow-up; headless `VIDEO_BACKEND` input (follow-up); any wasm-path change. |

## Components

- `apps/studio/src/lib/videoBackend.ts` — widened type, `resolveVideoBackend(search, stored, probe)` returns the resolved object (pure), `getVideoBackend()`/`getResolvedVideoBackend()` (memo), `setVideoBackend(choice)` (persist + memo reset), `stepExecutor()`, `ffmpegLaneCapacity()`, `parseCapabilities()`.
- `apps/studio/src/lib/autoBuild.ts` — counted lanes, `LaneCaps`, `nextActions(scenes, inFlight, caps = DEFAULT_LANE_CAPS)`.
- `apps/studio/src/components/Studio/useAutoBuild.ts` — async `start`/`resume` resolve caps once; `capsRef`; `!== 'wasm'` checks.
- `apps/studio/src/components/Studio/useScenePipeline.ts` — `runVideoJob` with BUSY retry; `executor` on the three request bodies; `!== 'wasm'` checks. `SceneAssembleBar.tsx`, `FinalCutBar.tsx` likewise.
- `apps/studio/src/store/studioApi.ts` — optional `executor` on the three mutations.
- `apps/studio/src/components/Studio/VideoBackendPicker.tsx` (+ test) — new.
- `apps/studio/.bffless/proxy-rules/studio/rules/api/video/{extract-audio,slice,concat}/post/{rule.yaml,prep.fn.js,check.fn.js}` — `executor` pass-through + forward-compatible error text; `check.fn.test.yaml` fixtures updated.
- `apps/studio/src/mocks/handlers.ts` — probe mock gains `executors`/`defaultExecutor` (+ a `mockVideoRemote` knob) so the picker is demoable offline.
- Docs: `apps/studio/CLAUDE.md` (override values), `README.md`, `catalog/description.md`, `CONTEXT.md` glossary (Browser / Server (auto) / Local server / Remote).

## Error handling

- Explicit `remote`/`local` that CE rejects at run time (`FFMPEG_EXECUTOR_UNAVAILABLE`, e.g. an admin turned it off after the probe) surfaces as today: job error → halt (resumable). No silent downgrade (product decision 2026-08-12).
- Probe failure never breaks the app (unchanged): resolves `wasm` unless a stored/override server choice exists.

## Testing

- `videoBackend.test.ts`: resolver matrix (override/stored/probe × executors present/absent × probe failure), alias `browser`, effective executor for `server`, `stepExecutor`, `ffmpegLaneCapacity`, memo/`setVideoBackend` reset.
- `autoBuild.test.ts`: `nextActions` at cap 1 (existing behaviour unchanged), cap 3 (three ffmpeg steps across scenes; a 4th waits), cap min(8, scenes), refine/sheets still 1, stitch gating unchanged.
- `useAutoBuild.test.tsx`: caps decided at Start from the resolved backend (remote ⇒ several cuts in flight; wasm ⇒ one).
- `useScenePipeline.*.test.tsx`: request bodies carry `executor` per choice; BUSY retry (fake timers) then success; non-transient error rethrows immediately.
- `VideoBackendPicker.test.tsx`: options disabled per probe, note shown on fallback, change persists.
- Rule fn tests (`check.fn.test.yaml`): error text with and without `stepErrors`.
