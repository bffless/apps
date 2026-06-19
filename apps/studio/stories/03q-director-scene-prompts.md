# 03q — the director writes per-scene *prompts*, not scripts

> Read `00-architecture-and-state.md` first, then `03l-scene-prompt-context.md`
> (this reuses 03l's per-scene `refinePrompt` plumbing) and `03p-word-timings-from-scratch.md`
> (which already cut `draftText` out of the refiner). Backend work uses the
> **`bffless-pipeline`** skill; the FE follows **`wire-studio-stage`**.

**Status:** ✅ shipped (2026-06-12; FE + rule `138f27fb` rewrite, see "Built"
below). Unlike 03l/03j/03k, the **live-Gemini effect is verified** — a real POST
returned per-scene `refinePrompt` (no `draftText`), honoring the creator direction.

## Why

The master director (`/api/scenes`, rule `138f27fb`) is called **once** at the
start with the whole talk — the timestamped transcript and the director contact
sheets. Its job is **big-picture**: write the synopsis, slice the talk into
scenes, group and title them. Today it *also* drafts a tightened per-scene script
(`draftText`) — and that script is **bad**, because writing finished narration is
the wrong job for a single whole-video pass.

It's also **dead weight**. Since story 03p the per-scene **refiner** ignores
`draftText` entirely — it rebuilds each scene's cut from scratch off precise
`wordTimings` + the creator's `direction`. So the director spends model budget
writing a script that nothing downstream reads, and the only place `draftText`
still surfaces is a pre-refine placeholder in the diff viewer.

**The reframe:** the director stops drafting text. Instead, having read the whole
talk, it authors the thing the refiner *does* consume — a **default refine prompt
for each scene**: a short natural-language instruction for how that scene should
be cut and re-voiced ("Tighten the rambling intro to a ~15s hook; drop the dead
air around 0:40; keep the screen-share visible; confident, fast tone").

That prompt **prepopulates the per-scene direction field we already have** (03l's
`scene.refinePrompt`). The director does **not** run the refiner — when the
producer opens a scene and hits Refine, the field is already filled with the
director's suggestion, editable, and flows to the refiner as its `direction`
through the existing 03l path. The refiner itself is **unchanged**.

## What does NOT change

- **The refiner** (`/api/refine-scene`, rule `afacb572`) — request shape, prompt,
  coercion (`toRefinement`), the `wordTimings`-from-scratch behavior: all untouched.
  It already receives `scene.refinePrompt` as `direction` (03l); now that field
  just arrives pre-filled.
- **The director's other outputs** — `synopsis`, scene `title`/`start`/`end`,
  `cuts`, `voicing` — unchanged. Only `draftText` → `refinePrompt`.
- **The non-destructive layers, the diff viewer, voicing, assemble** — all read
  `refined ?? baseline`; the only baseline that moves is the pre-refine segment
  fallback (see "Drop `draftText`" below).

## Design decisions (from the brainstorm, 2026-06-12)

- **Prefill the existing editable field directly** (`scene.refinePrompt`), not a
  separate read-only "director suggestion". The creator wanted the per-scene
  prompt *prepopulated* and editable. Rejected: (a) a distinct
  `directorRefinePrompt` field seeding `refinePrompt` so you could "reset to the
  AI suggestion" — extra state for something re-running the director already
  gives you (YAGNI); (b) showing it read-only above an empty textarea — not what
  "prepopulate" means.
- **Drop `draftText` entirely**, don't keep a vestigial empty field. Since 03p
  it's unread by the refiner; keeping an always-empty string would rot. Removing
  it also clears genuinely-orphaned code (legacy `SceneEditor`, `scenesToTimedWords`,
  the `updateDraft`/`generateVoice` hook actions) the diff-viewer rework left behind.
- **The director re-run already covers "regenerate the prompt".** Re-running the
  master director (03m, confirm-gated) rebuilds the scene list and re-prefills
  every `refinePrompt` — same as it replaces everything else today. No per-scene
  "regenerate prompt" button.
- **The global director prompt is untouched.** It still shows in the refine panel
  with its include-as-context checkbox (03l). The per-scene prompt prefills the
  textarea; the global prompt sits in its own row beneath it. Two distinct
  channels, exactly as 03l shipped them.
- **Pre-refine baseline falls back to the transcript.** With no `draftText`,
  `effectiveSegments` returns a single placeholder segment built from
  `scene.transcript` until the scene is refined (it was `draftText` before). It's
  only a placeholder; 03f Part D (gate the diff viewer behind a refinement) will
  retire it.

## Data model

```ts
// director.ts — the wire shape from /api/scenes, before coercion
type DirectorScene = {
  title?: string
  start: number
  end: number
  transcript?: string
  refinePrompt?: string        // NEW — the director's default prompt for this scene
  cuts?: Cut[]
  voicing?: 'original' | 'revoice' | 'mixed'
  // draftText  ← REMOVED
}

// scenes.ts
type Scene = {
  // … existing …
  refinePrompt?: string        // UNCHANGED field (03l) — now seeded by the director
  // draftText: string  ← REMOVED
}
```

No migration: `Scene.draftText` is removed outright. Old persisted sessions
rehydrate with a `draftText` key the type no longer declares — harmless (it's
just ignored; nothing reads it). `refinePrompt` stays optional, absent on old
scenes, which renders as an empty textarea exactly like today.

## Front-end

### Pure logic (`src/lib`)

- **`director.ts`**
  - `DirectorScene`: drop `draftText`, add `refinePrompt?: string`.
  - `toScenes`: stop setting `scene.draftText`; set
    `refinePrompt: str(s?.refinePrompt).trim() || undefined`. Title fallback uses
    the transcript lead words (`leadWords(transcript)`) instead of the draft.
  - Delete `scenesToTimedWords` (orphaned — no callers).
  - Update the module doc comment (it describes `draftText` as the director's job).
- **`scenes.ts`**
  - Remove `Scene.draftText`.
  - `buildScenes` (mock): stop emitting `draftText`; emit a deterministic
    `refinePrompt` per scene. `SHORTEN_RATIO` is now unused there — remove if it
    has no other reader.
- **`refiner.ts`**
  - `effectiveSegments`: build the pre-refine fallback segment from
    `scene.transcript` instead of `scene.draftText`. Update the doc comment.

### Orchestration (`useScenePipeline.ts`)

- Remove the orphaned `updateDraft` and `generateVoice` callbacks (both read
  `draftText`, neither is consumed by any component — they're pre-diff-viewer
  legacy) and drop them from the hook's return. `setRefinePrompt` (03l) already
  exists for editing the field; no new action needed — the director prefill
  arrives via `setScenes`/`toScenes`.

### UI

- **`SceneRefinePanel.tsx`** — the "Direction for this scene" textarea is already
  bound to `scene.refinePrompt`, so it now opens **prefilled** with the director's
  suggestion with zero wiring change. Two copy fixes only:
  - Relabel/hint the textarea so it reads as the director's editable suggestion
    (e.g. "Direction for this scene — the director's suggestion, edit freely")
    rather than implying it starts blank.
  - Drop the stale "Your original draft is kept — refining never overwrites it."
    sentence from the panel intro (there's no draft anymore).
- **`SceneMeta.tsx`** — the "Script" (`origWords → draftWords −reduction%`) and
  "Est. narration" stats currently derive from `draftText`. Re-derive them from
  the **effective** narration text — `effectiveSegments(scene).map(s => s.text).join(' ')`
  — which is more accurate (it tracks the refined script) and matches the rest of
  the panel, already on the effective layer.

### Delete (dead since the diff-viewer rework)

- `src/components/Studio/SceneEditor.tsx` and its test — a `draftText` editor never
  mounted in the current Build.

## Pipeline change (`/api/scenes`, rule `138f27fb` — bffless-pipeline skill)

Only the `prep` function-handler's `system_instruction`/`prompt` changes (the 03f
Part-0 enqueue + `postSteps` shape is untouched, and `parse` already passes scene
fields through opaquely):

- **Stop** asking for a per-scene tightened script. Remove `draftText` from the
  requested JSON scene shape.
- **Add** a per-scene `refinePrompt`: instruct the model to return, for each scene,
  a short imperative **instruction to the second-pass refiner** — how to cut and
  re-voice this scene given the whole-video context: what to tighten/drop, the
  pacing/tone, any on-screen thing to preserve, a rough target length. One to two
  sentences. It is a *prompt*, not narration.
- Keep `synopsis`, `title`, `start`/`end`, `cuts`, `voicing` exactly as today.

Back up the rule JSON to `.bffless-backups/2026-06-12-03q-scenes.json` before
editing; verify via the rule's debug logs that a live POST returns `refinePrompt`
(and no `draftText`) per scene. Validators (`auth_required`/`rate_limit`) stay off
until story 07.

## Mock (`src/mocks/handlers.ts` — mock-first, before the pipeline edit)

The `/api/scenes` mock builder currently sets `draftText: direction ? … : beat.draft`.
Change it to a deterministic `refinePrompt` per scene (e.g.
`` `Tighten this beat to a crisp run${direction ? `, ${direction}` : ''}; drop the dead air in the middle.` ``)
and drop `draftText`. Mock and real share the new shape, so swapping the mock for
the live pipeline never touches a component.

## Tests

- `director.test.ts` — `toScenes` sets `refinePrompt` from the wire field (present /
  trimmed / missing → undefined); no longer sets `draftText`; title falls back to
  the **transcript** lead words when `title` is absent.
- `refiner.test.ts` — `effectiveSegments` falls back to a single segment built from
  `scene.transcript` (was `draftText`) when there's no refinement; unchanged once
  `refined.segments` exist.
- `scenes.test.ts` / `buildScenes` — emits `refinePrompt`, not `draftText`.
- `SceneMeta` RTL — the Script/Est-narration stats reflect the effective segment
  text (pre-refine = transcript; post-refine = the refined script).
- Remove `SceneEditor.test.tsx` with the component; delete any `draftText`
  assertions left in director/refiner/handler tests.

## Acceptance criteria

- [x] Master director returns a per-scene `refinePrompt` and no `draftText`;
      `toScenes` seeds `scene.refinePrompt` and the title falls back to the
      transcript (director.ts + tests).
- [x] `Scene.draftText` is removed; nothing in `src/` references it; the pre-refine
      diff baseline (`effectiveSegments`) falls back to `scene.transcript`.
- [x] Opening a scene shows the "Direction for this scene" textarea **prefilled**
      with the director's suggestion, editable, persisted, surviving refine-revert
      (reuses 03l `refinePrompt`); the global director-prompt context row is
      unchanged.
- [x] Refining a scene sends that (possibly edited) prompt as `direction` with no
      code change to the refiner — `/api/refine-scene` (rule `afacb572`) and
      `toRefinement` are untouched.
- [x] `SceneMeta`'s Script + Est-narration stats derive from the effective
      narration text, not `draftText`.
- [x] Orphaned code removed: `SceneEditor.tsx`, `scenesToTimedWords`,
      `updateDraft`, `generateVoice` (also the dead `voicingId` flag + `SHORTEN_RATIO`).
- [x] Rule `138f27fb` `prep` **and** `parse` rewritten to request/emit `refinePrompt`
      and drop `draftText`; backup saved; live-verified; rule id + memory updated.
- [x] MSW mock emits `refinePrompt` (no `draftText`); mock and real share the shape.
- [x] `npm run build`, `npm run lint` (only the two pre-existing `ChatPanel.tsx`
      errors), `npm run test:run` (283) all green.

## Built — rule edit (2026-06-12)

- **Rule `138f27fb-9fd1-4986-bc84-ac2b2a4a020c` (`POST /api/scenes`)** — only the
  `prep` and `parse` function-handlers changed; the 03f Part-0 enqueue + `postSteps`
  (sign → collect → Gemini → finishOk/finishErr) are untouched. Pre-edit backup:
  `.bffless-backups/2026-06-12-03q-scenes.json`. A pre-apply diff confirmed **only
  those two steps** differed from the backup.
  - `prep`: the `system_instruction` now frames the director as "BIG PICTURE only",
    drops job-item 3's "rewrite the narration into a tight script (draftText)" in
    favour of "write a REFINE PROMPT (refinePrompt) … a DIRECTION for the editor,
    NOT narration", and the requested JSON scene shape swaps `draftText` →
    `refinePrompt`. Synopsis/title/start/end/cuts/voicing unchanged.
  - `parse`: the per-scene `sceneOut` drops `draftText`, adds
    `refinePrompt` (only when non-empty). Clamps/sort/voicing unchanged.
- **Live-verified** (debug on): a real `POST /api/scenes`
  (`direction:"keep it punchy"`) enqueued a job that ran to `status:done` — the
  stored `system` mentions `refinePrompt` and **not** `draftText`, and the parsed
  result scene has keys `[cuts,end,refinePrompt,start,title,transcript,voicing]`
  with a genuine per-scene instruction ("Keep the delivery punchy … aggressively
  trim all the dead air …"). The Replicate token is configured, so this also
  confirms the **live steering effect** (the model obeyed the direction) — the
  caveat left open in 03l/03j/03k.

## Out of scope

- Any change to the refiner pipeline, request, or coercion (03c/03o/03p own it).
- A per-scene "regenerate just this prompt" action — re-run the director (03m).
- 03f Part A's *global* `refinerBrief` (a separate, whole-video handoff). This
  story is the **per-scene** prompt; the two can coexist later if Part A lands.
- Editing the **global** director prompt from Build (still include/exclude only, 03l).
- Validators (`auth_required`/`rate_limit`) — story 07.
