# 06 — Thumbnail studio (nano banana)

> Read `00-architecture-and-state.md` first.

**Status:** ✅ shipped (FE + mock) · ✅ live rules created · ⏳ skill deploy + console toggles pending · **Backend: BFFless `ai_handler` (+ `image-prompts` skill) → `replicate` (`google/nano-banana`).**

**Live rules (studio rule set `cf413ff6`):**
- `POST /api/thumbnail/draft` → `9a55c17b-7c2a-4349-8938-1059ffe70f35` (ai_handler `claude-sonnet-4-6`; system prompt set; `draft` step timeout 110 s)
- `POST /api/thumbnail/render` → `c6b3ddd5-0785-4882-a342-0dbe270d5269` (replicate `google/nano-banana` → bucket)
- upload schema `youtube_thumbnail` `504045c5-bc4d-4d67-a095-7f3e333911ab` (+ `GET /api/uploads/youtube-thumbnail/*`)

**Still needed to go fully live:** (1) deploy so `.bffless/skills/image-prompts/` ships; (2) in the console, on the draft handler: Skills → Select Skills → `image-prompts`, and Response Format → JSON. Until then the handler fabricates a fake skill (verified) and the output is unusable.
Self-contained side feature; ships independently of the pipeline stories.

> **Not the director thumbnails.** This is the **final YouTube thumbnail image**,
> an AI **output** we get **back** when everything's done — totally separate from
> the interval contact sheet we **give** the master director as input (story 03 /
> `00` "Two kinds of thumbnails"), and separate again from the project-card image
> (`ProjectMeta.thumbnailUrl`, derived from the first contact sheet). Three things
> named "thumbnail"; this story is only the YouTube output.

## Goal

Generate the **final YouTube thumbnail** in the Export phase, replacing the manual
flow (run the `image-prompts` skill by hand → paste into nano-banana → download).
The creator writes free-text notes about what they want, an AI handler **drafts**
the nano-banana prompt (it loads the `image-prompts` skill to do the prompt-craft),
the creator **edits** it, then **`google/nano-banana`** renders the image — saved
to the bucket + the project record and re-downloadable.

**Text-only** (no reference frame fed to nano-banana). **No variations grid.**

## Backend — two endpoints

Two steps because the creator edits the drafted prompt between them.

### 1. `POST /api/thumbnail/draft` — draft the prompt

`ai_handler`, **Response Format: JSON**, **one-time completion** (not chat),
**Skills Mode: Select Skills → `image-prompts`** (Skills Path `.bffless/skills`).
The handler uses the `load_skill` tool to pull in the skill's prompt anatomy,
house styles, and routing. Request body (templated into the user message):
`{ title, description, script, notes }`. Returns `{ prompt }`.

**System prompt (paste verbatim into the rule):**

> You write a single image-generation prompt for `google/nano-banana` that becomes
> a YouTube video's final thumbnail.
>
> You have the **`image-prompts` skill** — **load it with `load_skill` before
> writing.** It defines the prompt anatomy, the named house styles
> (retro-blueprint / modern-dev-tool / editorial-print), how to route a style from
> the video's content type, the text/color/negatives rules, and examples. Follow
> it exactly; don't invent your own format.
>
> The user message gives you **TITLE**, **DESCRIPTION**, **SCRIPT** (the final
> spoken script — your evidence for what the video is about and which house style
> fits), and **NOTES** (the creator's optional free-text wishes). When NOTES are
> present they **override** style routing and defaults — honor them.
>
> Route the house style from the content type per the skill. Write the exact
> headline text yourself (≤5 words) — never a placeholder. Apply the skill's color
> caps and always include the negatives list.
>
> Return **JSON only**: `{ "prompt": "<full multi-section prompt, ready to
> paste>" }` — no commentary, no markdown fences.

### 2. `POST /api/thumbnail/render` — render the image

`replicate` `google/nano-banana` with `input.prompt = {{steps.form.prompt}}`, then
`file_upload` stores the output under `projects/<id>/youtube-thumbnail/`, and a
`response_handler` returns `{ imageUrl }` (a `/api/uploads/...` serve path).
Request body: `{ prompt, projectId }`.

Validators (`auth_required` + `rate_limit`) stay **off** until story 07, like the
rest of the studio pipeline. Live AI needs the project Replicate token (Settings →
AI) or you get `REPLICATE_NOT_CONFIGURED`.

## Front-end (shipped)

- **`src/lib/thumbnail.ts`** — pure shape layer: `buildThumbnailDraftRequest`,
  `toThumbnailPrompt`, `toThumbnailImage` (mock + real coerce through these).
- **MSW** mocks for both endpoints in `src/mocks/handlers.ts` (gated by
  `MOCK_STUDIO`); same `{prompt}` / `{imageUrl}` shapes as the real pipeline.
- **RTK Query** `thumbnailDraft` + `thumbnailRender` (`studioApi.ts`); new
  `'youtube-thumbnail'` `UploadKind`.
- **Redux** durable `youtubeThumbnail: { notes, prompt, url } | null` on the
  project working state (url-only; rides story 11d server-sync; re-signed via
  `/api/uploads/sign` on load — never `file_serve`).
- **`useScenePipeline`** actions `draftThumbnailPrompt` / `renderThumbnail`
  (+ `draftingThumbnail` / `renderingThumbnail` flags), plus exposes `signFor`.
- **`src/components/Studio/ThumbnailStudio.tsx`** in the Export step beside
  `ExportSummary`/`FinalCutBar`: notes → Draft prompt → editable prompt → Generate
  / Regenerate → signed image + Download.

## Acceptance criteria

- [x] With the mock: notes → editable drafted prompt → Generate → image →
      Regenerate → download; the thumbnail persists on the project + survives reload.
- [ ] Real pipeline: `/api/thumbnail/draft` (skill-driven) + `/api/thumbnail/render`
      (`google/nano-banana`) return the same `{prompt}` / `{imageUrl}` shapes;
      `MOCK_STUDIO = false`.
- [x] build / lint / test:run pass.

## To go live (swap step — BFFless console/MCP)

1. Create the two rules above; **select the `image-prompts` skill** on the draft
   handler and paste the system prompt.
2. Attach to the studio rule set / alias (see memory `project_studio_rule_set_alias`).
3. Ensure `.bffless/skills/image-prompts/` is deployed (committed in this story).
4. Set the Replicate token; flip `MOCK_STUDIO = false`; smoke-test.

## Out of scope

Reference-frame / image-to-image input, variations grid, brand-template /
overlay-text compositing, billing/gating (story 07).
