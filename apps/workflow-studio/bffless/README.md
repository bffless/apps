# Workflow Studio backend — BFFless proxy rule set

One authored set, [`workflow-studio`](../.bffless/proxy-rules/workflow-studio/) — thirteen rules
serving every `uses: pipeline` step in [`studio.workflow.yaml`](../.bffless/workflows/studio.workflow.yaml):
the job poll (`job`), the video ops (`video/extract-audio`, `video/contact-sheet`, `video/slice`,
`video/concat`, `video/frames`), the AI stages (`transcribe`, `scenes`, `refine-scene`, `describe`,
`blog`) and the cover (`thumbnail/draft`, `thumbnail/render`), over two schemas
(`workflow_studio_jobs` for the async job rows, `workflow_studio_uploads` for the stored cover).
Like `apps/workflow`'s own `workflow` set (see
`apps/workflow/bffless/README.md` → "Rule-set isolation"), it lives in project
**`bffless/workflow`**, NOT in `.bffless/config.json`'s `ruleSets` globs — that file drives the
nightly drift check against project `bffless/apps`. Keep it out of it.

## Manual setup (admin panel)

Everything below is one-time, per-project setup a human does in the BFFless admin panel — none of
it is carried by the rule set (secrets, provider tokens and response-header rules are project
settings, not rule-set JSON).

- **Project**: `bffless/workflow` — the same project as the harness and
  `bffless/workflow-hello` (see `apps/workflow/bffless/README.md` → "Manual setup" for why:
  discovery lists *this project's* aliases).
- **Domain is OPTIONAL.** Since `bffless/publish-workflow@v1.2.0`, the harness forwards
  `/w/workflow-studio/*` to this alias **in-process** (the backend calls itself at
  `localhost:3000`, no nginx hop) — see `apps/workflow/bffless/README.md`'s
  `/w/hello/[...path]` note for the mechanism. Nothing needs a domain for the harness to
  work. If someone maps one anyway for direct human browsing, the domain's path is
  **`/<the deploy's `path` input>`**, never `/` — `bffless/upload-artifact` keeps the uploaded
  directory name AS GIVEN as the bundle's root, so the alias's content root is the whole
  monorepo-relative path this deploy uploads. For this repo that literal is
  **`/apps/workflow-studio/dist`** (`.github/workflows/deploy-workflow-studio.yml` passes
  `path: apps/workflow-studio/dist`, because a monorepo app is not the repo root). A path of
  `/` (or empty) 400s (double slash) or 404s. Note this is NOT hello's `/dist`: that repo IS
  the implementation, so its own deploy passes the bare `path: dist`.
- **`HF_TOKEN` secret** and the **Replicate + Anthropic provider tokens**, all on project
  `bffless/workflow` (Settings → AI). Same roles as in Studio's own backend
  (`apps/studio/bffless/README.md` → "Prerequisites"), and these are the only credentials the
  rule set names — `secrets.HF_TOKEN` is referenced once (`transcribe`, WhisperX diarization);
  everything else is a project **provider token**, never a `secrets.*` reference:

  | Credential | Where the rule set uses it |
  | --- | --- |
  | `HF_TOKEN` secret | `transcribe` → `victor-upmeet/whisperx` (`huggingface_access_token`) |
  | Replicate provider token | `transcribe` (WhisperX), `scenes` (`google/gemini-3.1-pro`), `refine-scene` (`google/gemini-3.5-flash`, both the hearing and the deaf pass), `thumbnail/render` (`google/nano-banana-2`), and `blog`'s disabled Gemini writer |
  | Anthropic provider token | `describe` (`claude-opus-4-6`), `blog` (`claude-opus-4-6`, the enabled writer), `thumbnail/draft` (`claude-sonnet-4-6`) |

  These are project-level, so if `bffless/workflow` already runs other implementations,
  they're shared with this one — set once.
- **Skills need no setup.** Like Studio, the `describe`, `thumbnail/draft` and `blog` steps
  load a skill (`video-description`, `image-prompts`, `bffless-docs`); unlike Studio, which
  relied on the project's Skills Source, each step's `skills:` block names the source itself:
  `alias: workflow-studio` + `path: apps/workflow-studio/dist/.bffless/skills` — the bundle
  this repo publishes (`scripts/stage.mjs` copies `.bffless/skills/` in; the deploy's `path`
  input is the prefix). CE resolves the alias inside project `bffless/workflow`, so the rule
  set — which runs under the HARNESS alias — still reads this implementation's own
  deployment. Leave the project's Skills Source / Skills Path alone; a per-step alias wins
  over them, and setting them would only affect implementations that don't name their own.
  Each system prompt is still complete without its skill, so a missing skill degrades, never
  fails.
- **Server video ops enabled** — Admin → Settings → Features → Server video ops, **CE ≥ 0.4.37**
  with `frames` present in the capabilities probe's `probe.ops` (the contact-sheet stage needs
  it; earlier CE has `slice`/`concat`/`extract-audio` but not `frames`). Without it the
  browser-side `ffmpeg.wasm` fallback still works but the contact-sheet step is slower and
  memory-heavier in-browser.
- **The two `no-transform` response-header rules**, both on project `bffless/workflow` — same
  rules the harness itself needs (`apps/workflow/bffless/README.md` → "Response-header rules"),
  already in place if `bffless/workflow-hello` is installed in this project. If this is the
  first implementation installed here, create both via MCP `create_response_header_rule` (not
  yet expressible as rules-as-code — bffless/ce#700):
  - `**/islands/*.html` → `Cache-Control: no-transform, no-cache`
  - `**/scripts/*.js` → `Cache-Control: no-transform, no-cache`
- **Bucket CORS** must list the harness origin (`https://workflow.<domain>`) — the cut editor's
  presigned uploads and the video-ops jobs both go straight browser-to-bucket. See
  `apps/workflow/bffless/README.md` → "Storage" for the exact `gcloud storage buckets update
  --cors-file` recipe; add `workflow.<domain>` alongside whatever origins are already listed.
- **Member role**: `workflow-ci@bffless.app` (the account the M1/M2 harness live walks and the
  headless dispatch use) needs at least **contributor** on `bffless/workflow` — one step above
  the harness's own bare-minimum **viewer** (`apps/workflow/bffless/README.md` → "Members need a
  project role"), because this implementation's kickoff/upload/video-ops pipelines are writes,
  not just reads.

### The one-time setup checklist, in order

Everything above, as steps someone can execute unattended. **None of it has been performed** —
the port's PR creates no secret, domain, alias or member grant; a merge of that PR is what first
publishes the implementation, and these are its preconditions. Run them against the instance the
harness lives on (`https://j5s.dev` below; substitute your own). Project is **`bffless/workflow`**
for every step.

1. **`HF_TOKEN` secret** — MCP `set_secret` with `project: "bffless/workflow"`, `key: "HF_TOKEN"`,
   and a Hugging Face access token that has accepted the `pyannote` gated-model terms (the same
   token Studio's own backend uses; see `apps/studio/bffless/README.md`). Verify with
   `list_secrets` — the key is listed, the value never is.
2. **Provider tokens (Replicate + Anthropic)** — admin panel → the `bffless/workflow` project →
   **Settings → AI**. These are project settings, not secrets, and do not appear in
   `list_secrets`. Both are needed: Replicate serves `transcribe`, `scenes`, `refine-scene`,
   `thumbnail/render`; Anthropic serves `describe`, `blog`, `thumbnail/draft`. If
   `bffless/workflow-hello` or another implementation already runs here, they may be set already —
   check before adding.
3. **Server video ops** — admin panel → **Settings → Features → Server video ops**, enabled, on a
   CE **≥ 0.4.37** (the release that adds the `frames` op). Confirm the capabilities probe reports
   `frames` among `probe.ops`; without it the contact-sheet stage falls back to in-browser
   `ffmpeg.wasm` (slower, memory-heavier) and the `video/frames` rule has nothing to call.
4. **The two `no-transform` response-header rules** — MCP `create_response_header_rule`, twice, on
   `bffless/workflow` (bffless/ce#700: not yet expressible as rules-as-code). Already present if
   another implementation is installed here — `list_response_header_rules` first.
   - pattern `**/islands/*.html` → header `Cache-Control: no-transform, no-cache`
   - pattern `**/scripts/*.js` → header `Cache-Control: no-transform, no-cache`
5. **Bucket CORS** — the harness origin (`https://workflow.j5s.dev`) must be in the bucket's CORS
   origins; the cut editor's presigned uploads and every video-ops job go browser-to-bucket. See
   `apps/workflow/bffless/README.md` → "Storage" for the `gcloud storage buckets update
   --cors-file` recipe. Already done for the harness itself, so usually a no-op — verify rather
   than re-apply.
6. **Member role** — admin panel → the `bffless/workflow` project → **Members**: give
   `workflow-ci@bffless.app` **contributor** (not just viewer — this implementation writes). An
   API key is never an admin; the project-permission row is the only authority (see the workspace
   memory note "CE API key acts as role user").
7. **Merge the port, or dispatch the deploy** — `.github/workflows/deploy-workflow-studio.yml`
   runs on a push to `main` touching `apps/workflow-studio/**`, and on `workflow_dispatch`. It
   stages the bundle and hands it to `bffless/publish-workflow@v1`, which lints + indexes the
   workflow, syncs the rule set under `/api/workflow-studio/`, uploads the bundle to alias
   `workflow-studio` and attaches the set to the harness alias. Repository variable
   `BFFLESS_URL` and secret `BFFLESS_WORKFLOW_API_KEY` (both already on `bffless/apps`) are its
   only credentials. **A merge is a live deploy** — there is no dry run.
8. **Optional: a domain.** Only if a human wants to browse the bundle directly; the harness never
   needs it (see "Domain is OPTIONAL" above). MCP `create_domain` on `bffless/workflow`, domain
   `workflow-studio.j5s.dev`, alias `workflow-studio`, SPA fallback **off**, and **path
   `/<the deploy's `path` input>`, never `/`** — for this repo the literal
   **`/apps/workflow-studio/dist`**, since that is what
   `.github/workflows/deploy-workflow-studio.yml` uploads (not hello's `/dist`, which comes
   from hello's own bare `path: dist`). Create it *after* the first publish — the alias does
   not exist until then.

## Known limitations / follow-ups

Things that work, but not as well as they should. None blocks the first success.

- **`FFMPEG_BUSY` retries are not live yet.** Studio's own client-side retry
  (`src/lib/videoJobRetry.ts`) needs CE to surface `stepErrors` on a job row — open upstream as
  bffless/ce#662. Until that ships, a transient `FFMPEG_BUSY` on a server video-ops step fails
  the step once; re-run the workflow (or the affected job) rather than expecting an automatic
  retry.
- **No per-scene dense contact sheets.** Studio plans a second, tighter sheet per scene
  (`planSceneContactSheet`) so the per-scene refine pass sees that scene's frames at high
  density. The port has ONE plan across the whole project (the `plan` job's
  `planGlobalSheetCaptures`, R147), so `refine-scene` sees its source's ≤ 10 sheets sampled
  at the project's spacing — enough to pick cuts, coarser than Studio's. A fix means a
  second `video/contact-sheet` call inside the `per-scene` matrix job.
- **A throwing `check`/`parse` leaves the job `running`.** A `function_handler` that throws
  produces no status at all (not a failure status), so the workflow's poll sees an unchanged row
  and keeps polling until the step's timeout rather than failing fast. The rules avoid throwing
  on the paths that matter; a rule that starts throwing degrades to a slow timeout, not a clear
  error.
- **Sync failure envelopes are hand-built JSON.** A sync rule has no job row to write an error
  onto (R120), so each one answers with a second, `notOk`-gated `response_handler` whose `body` is
  a JSON literal written out in the rule YAML with `{{steps.parse.error}}` interpolated into it —
  not `JSON.stringify` of an object, the way the success bodies are built. Every message the rules
  themselves produce is quote-free and single-line, so this is correct today; a message that ever
  carried a `"` or a newline through from upstream would emit invalid JSON, and the shape has to
  be edited in each of the rules separately.

## First-success checkpoint

**Walked 2026-08-30 (apps#359 Task 25)** with `pnpm workflow-live:walk studio-audit` and
`pnpm workflow-live:walk studio-headless` (`packages/workflow-live`), both on `workflow.j5s.dev` as
`workflow-ci`. Row names are the walks' check ids.

**Interactive — audited, no kickoff.** The by-hand run of 2026-08-29,
`run_01M17CG3W0YTA4T0ZVRTD88VE7`, 7/7: `run.succeeded`; `R.scenesCarrySourceSpans` (2 scenes, each
with `source`/`sourceIndex`/`spans`); `D2.sheetsDrawn` (`sheets/0/sheets` → `drawn: true`, the
global labels burned in); `trim.keepRecorded` (keeps 3 + 2); `outputs.shortBlogCoverAreFileRefs`
(`short.mp4` 20.3 MB, the blog zip 369 KB, a cover JPEG); `D16.wordsNotOffloaded` (a 4-minute
clip's `words` stays inline — a 1-hour source would offload); `run.interactiveFlag`.

**Headless — one kickoff.** The committed fixture clip
(`packages/workflow-live/fixtures/onboarding-rules.mp4`: 854×480, 224 s, spoken audio, sha-pinned)
with `{ write_blog: true, cover: true, accept_cuts: true }` and `--timeout 90m`:
`run_01M19GV5DDXBB3QHFN8BHH7896` **succeeded in 3 m 53 s** (14:23:06 → 14:26:59 UTC), driver exit 0,
`run.headless: true`. Proven: the six common checks above (4 scenes this time); every `trim` —
`headless: auto` — accepted the refiner's cuts unattended (`D7.trimAutoAccepted`, its 240-minute
budget irrelevant); `blog/0/review` (island) skipped with `post`; `cover/0/direction` +
`cover/0/review` (forms) skipped; `cover/0/render` succeeded with a File ref
(`D11.blogReviewSkippedWithPost`, `D11.coverFormsSkipped`, `cover.rendered`); the driver saved
`outputs/short.mp4`, `outputs/cover.jpg` and `outputs/blog.zip` = `post.md` + 6
`images/frame-*.jpg` (`blog.zipHasFrames`). One drift caught: the walk shipped with the
pre-apps#429/#430 step names (`blog/0/edit`, `pick/0/pick`) and reported those two rows `absent`;
the checks were re-pointed the same day and pass on this run's saved record
(`packages/workflow-live/test/fixtures/studio-headless.json`). No harness defect was disproved.

**Per-run spend** (headless, 4-minute clip): WhisperX ×1, Gemini director ×1 + refiner ×4, Claude
describe ×1 + blog ×1, cover draft ×1 + one image render. Wall-clock under 4 minutes.

**Not walked by machine:** the interactive Studio run (the cut-editor island stays a by-hand
affair, audited above). The setup checklist in this README had been performed by hand before
the 2026-08-29 run.
