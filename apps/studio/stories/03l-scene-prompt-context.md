# 03l — scene prompts: per-scene direction + director-prompt passthrough

> Read `00-architecture-and-state.md` first. This absorbs **03f Part B** (per-scene
> custom prompt) into its own story; 03f's Parts A (AI `refinerBrief`), C (scene
> synopsis), and D (diff-viewer gating) are untouched and stay queued there.

**Status:** ✅ shipped (2026-06-11; FE + rule `afacb572` prep, see "Built" below).
Live-Gemini *steering effect* unverified until a real cut+refine runs — same
deferral as 03j/03k.

## Why

The creator can already steer the **master director** with free-text direction
("keep the demo at 12:30, punchier intro") — but that text is sent once to
`/api/scenes` and thrown away (transient `useState` in `Studio.tsx:44`). The
**per-scene refiner** never sees it: `useScenePipeline.refineScene` hardcodes
`direction: ''` today, so the second pass runs without the creator's intent.

Two gaps, one feature:

1. **Director prompt → every refine.** The direction the creator gave the master
   director is good *global* context for each scene's second pass. Forward it.
2. **Per-scene instructions.** Sometimes one scene needs its own steer ("trim the
   long pause", "keep the on-screen code visible"). Give each scene a free-text
   prompt of its own.

The Build UI must make the passthrough visible and controllable: the scene's
refine panel shows the director prompt read-only with a **checkbox (default
checked)** — include it as context or don't. No editing it from Build (re-run
the director / hop back to Prep for that).

## Design decisions (from the brainstorm, 2026-06-11)

- **Two labeled fields, not one concatenated string.** The refine request keeps
  the existing per-scene `direction` (finally populated) and gains
  `directorDirection` (the global prompt). The pipeline `prep` labels each
  distinctly in the Gemini prompt, so the model knows what's whole-video context
  vs. this-scene instruction. Rejected: client-side concatenation into one
  `direction` (prompt structure leaks into FE code; the backend `prep` ignores
  `direction` today so it needs editing either way) and a backend-side lookup of
  the director prompt (no natural join key from a refine call to the scenes job;
  extra `data_query` per refine; breaks mock symmetry).
- **The checkbox is per-scene and persisted.** Each scene remembers its own
  include/exclude choice (default: include). Unchecking scene 3 survives reloads
  and re-refines and doesn't affect other scenes.
- **The director prompt becomes durable state.** `direction` moves from
  transient React state into the persisted Redux `studio` slice — Build needs it
  long after prep, across reloads. Old persisted sessions rehydrate without the
  key and fall back to `''` (redux-persist top-level merge) — no migration.
- **Refine sends the *current* slice value.** If the creator hops back to Prep
  and edits the direction without re-running the director, later refines forward
  the edited text. It's context, not a contract — current text wins.
- **Inputs survive revert.** `refinePrompt` and `includeDirection` live on the
  scene (input layer), not on `scene.refined` — `clearRefinement` leaves them
  alone and they seed the next re-refine, same rule as 03f spec'd for
  `refinePrompt`.

## Data model

```ts
// studioSlice.ts — persisted; cleared by resetStudio (in initialState)
direction: string            // creator's free-text direction to the master director
setDirection(text)           // plain setter

// scenes.ts — both optional, no migration; persist via existing patchScene
type Scene = {
  refinePrompt?: string      // creator's per-scene instruction (03f Part B's field)
  includeDirection?: boolean // include the director prompt as refine context; ABSENT = true
}
```

## Request shaping (`src/lib/refiner.ts`)

```ts
export type RefineSceneRequest = {
  // … existing …
  direction: string          // scene.refinePrompt, trimmed ('' if none) — no longer hardcoded ''
  directorDirection: string  // global prompt when includeDirection !== false, else ''
}
```

Add a small **pure helper** so the trim/default/checkbox logic is unit-testable
(the payload is otherwise built inline in `useScenePipeline.refineScene`):

```ts
/** The two creator-prompt fields of a refine request. */
export function refineDirections(
  scene: Pick<Scene, 'refinePrompt' | 'includeDirection'>,
  direction: string,
): { direction: string; directorDirection: string }
```

## Orchestration (`useScenePipeline.ts`)

- `runDirector` reads `direction` from the slice (drop it from `StepContext` —
  one less prop threaded from the page).
- `refineScene` spreads `...refineDirections(scene, direction)` into the request
  (replacing the hardcoded `direction: ''`).
- New actions, both thin `patchScene` wrappers, exposed by the hook:
  `setRefinePrompt(id, text)` and `setIncludeDirection(id, on)`.

## UI

- **`Studio.tsx`** — delete the `useState('')` for `direction`; `DirectorPanel`
  binds to the slice via selector + `setDirection` dispatch. No visual change.
- **`SceneRefinePanel.tsx`** — stays presentational: new props `direction`
  (the global prompt, for display), `onRefinePromptChange`, and
  `onIncludeDirectionChange`, wired in `Studio.tsx` to the hook's actions. New
  block between step 1 (contact sheets) and step 2 (refine), since it's input
  the Refine button consumes:
  - **Textarea** "Direction for this scene · optional", styled like
    `DirectorPanel`'s textarea, bound to `scene.refinePrompt`, disabled while
    busy. Placeholder: "e.g. Trim the long pause; keep the on-screen code
    visible."
  - **Director-prompt context row** — rendered only when a non-empty director
    prompt exists: a checkbox (checked unless `includeDirection === false`)
    labeled "Include your director prompt as context", the prompt text shown
    beneath it read-only/muted. No row at all when there's no director prompt.
  - Re-refine reuses whatever's in the textarea + checkbox; Revert touches
    neither.

## Pipeline changes (`/api/refine-scene`, rule `afacb572` — bffless-pipeline skill)

Only the `prep` function-handler changes (the 03f Part 0 async shape is
untouched). Inject each field **only when non-empty**, with its own label:

- `directorDirection` → "The creator's overall direction for the whole video
  (context): …"
- `direction` → "The creator's instructions for this scene (follow these): …"

`/api/scenes` (rule `138f27fb`) is untouched — it already receives `direction`.

## Mock (`src/mocks/handlers.ts` — mock-first, before any pipeline edit)

The `/api/refine-scene` handler accepts `direction` + `directorDirection` so
mock and real share the request shape. Deterministic output unchanged (the
response shape doesn't change in this story).

## Tests

- `refiner.test.ts` — `refineDirections`: trims both fields; absent
  `includeDirection` means include; `false` → `directorDirection: ''`; empty
  global direction → `''` regardless of the checkbox.
- RTL on `SceneRefinePanel`: textarea edits call `onRefinePromptChange`; the
  context row is absent when `direction` is empty; unchecking calls
  `onIncludeDirectionChange(false)`.
- Existing `toRefinement` tests untouched (response shape unchanged).

## Acceptance criteria

- [x] Director prompt persists in the slice (`direction` + `setDirection`),
      `DirectorPanel` bound to it, `resetStudio` clears it; `/api/scenes`
      behavior unchanged.
- [x] Every refine request carries `direction` (= the scene's `refinePrompt`)
      and `directorDirection` (= the global prompt, `''` when the scene's
      checkbox is unchecked) — no hardcoded `''` (`refineDirections`, unit-tested).
- [x] `SceneRefinePanel` has the per-scene textarea + the default-checked
      include-checkbox with the read-only director prompt; row hidden when no
      director prompt exists (RTL-tested); both inputs survive revert and reloads
      (input-layer scene fields, persisted).
- [x] Rule `afacb572` `prep` injects both fields, labeled, only when non-empty;
      rule edit recorded here (debug-log verified) + memory updated.
- [x] MSW mock accepts the new fields; mock and real share the request shape
      (swap-don't-rewrite holds).
- [x] `npm run build` / `npm run test:run` green; `npm run lint` shows only the
      two pre-existing `ChatPanel.tsx` errors (known 03i debt, untouched).

## Built — rule edit (2026-06-11)

- **Rule `afacb572` (`POST /api/refine-scene`)** — only the `prep` function-handler
  changed (the 03f Part 0 enqueue/postSteps shape untouched). Pre-edit backup:
  `.bffless-backups/2026-06-11-03l-refine-scene.json`. The prep code already read
  `body.direction` (03c-era, always `''` from the FE until now) and injected it as
  "EXTRA DIRECTION FROM THE CREATOR"; that block is replaced by the two labeled
  injections, each trimmed server-side and added only when non-empty, in order:
  1. `THE CREATOR'S OVERALL DIRECTION FOR THE WHOLE VIDEO (context for this scene): <directorDirection>`
  2. `THE CREATOR'S INSTRUCTIONS FOR THIS SCENE (follow these): <direction>`
- **Verified via debug logs** (rule ships with debug on): a live POST with both
  fields shows both labeled lines in `steps.prep.prompt` immediately before the
  closing "produce STRICT JSON" instruction; a POST with both fields empty shows
  neither label. Enqueue path unchanged (`{ jobId, status: 'pending' }`, ~10 ms).
- ⚠️ Same caveat as 03j/03k: the **live-Gemini steering effect** (does the model
  actually obey the prompts?) is unverified until a real cut+refine runs.

## Out of scope

- **03f Part A** — the AI-generated `refinerBrief` (director-authored handoff).
  Different feature: that's the *model* summarizing the talk for the refiners;
  this story forwards the *creator's own words*. Still queued in 03f.
- **03f Part C/D** — scene synopsis from the refiner; gating the diff viewer.
- Editing the director prompt from Build (it's include/exclude only there).
- The dormant director→refiner per-scene direction handoff noted in 03j.
- Validators (`auth_required`/`rate_limit`) — still story 07.
