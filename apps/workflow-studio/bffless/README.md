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
  work. If someone maps one anyway for direct human browsing, the alias's content root is
  `dist/` (`bffless/upload-artifact` keeps the uploaded directory name as the bundle's root),
  so the domain's path is **`/dist`**, not `/` — a path of `/` (or empty) 400s or 404s, same
  as `hello.<domain>` in the harness's own README.
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
  they're shared with this one — set once. Studio pointed its `describe`, `thumbnail/draft`
  and `blog` steps at skills under `apps/studio/dist/bffless/skills`; this app ships no skills
  directory, so those steps run on their self-contained system prompts (each says in as many
  words that its defaults are complete without a skill).
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
- **`FFMPEG_BUSY` retries are not live yet.** Studio's own client-side retry
  (`src/lib/videoJobRetry.ts`) needs CE to surface `stepErrors` on a job row — open upstream as
  bffless/ce#662. Until that ships, a transient `FFMPEG_BUSY` on a server video-ops step fails
  the step once; re-run the workflow (or the affected job) rather than expecting an automatic
  retry.

## First-success checkpoint

**Stub — Task 25 fills this in** once the workflow YAML (Task 19), the rules (Tasks 20–21), the
built scripts (Task 22) and the cut-editor island (Task 23) all exist and the implementation is
staged/deployed (Task 24). There is nothing to run yet.
