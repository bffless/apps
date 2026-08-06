# Studio

Turn one long, rambly screen recording into a short, watchable video — in your own recorded
voice. Nothing is re-voiced and the AI never rewrites what you said. Import a recording, let the
AI director split it into scenes and propose cuts, tune those cuts on the transcript grid, and
export in your browser with ffmpeg.wasm.

Studio is a static app with no server. Every backend step is a BFFless pipeline running on your
own instance, so you bring the credentials.

## Setup

Install Studio from Admin → Apps, then configure these in the project you installed it into.

| What | Where | Required? | What it powers |
| --- | --- | --- | --- |
| Replicate token | Settings → AI → **Replicate** ([get one](https://replicate.com/account/api-tokens)) | Yes | Transcription (WhisperX), scene direction and the per-scene refiner (Gemini), voice clone and speech (MiniMax), thumbnail rendering |
| Anthropic key | Settings → AI → **LLM Providers** → Add Provider ([get one](https://console.anthropic.com/settings/keys)) | For thumbnails and the blog writer | Thumbnail prompt drafts (Claude Sonnet), companion blog writer (Claude Opus) |
| Storage bucket | Settings → Storage | Yes | Presigned direct-to-bucket uploads; Studio writes under `<owner>/<repo>/uploads/…` |
| Cross-origin isolation | Settings → Response Headers → Add Rule → **Cross-Origin Isolation** preset | Yes for fast export | `SharedArrayBuffer`, which multithreaded `ffmpeg.wasm` needs. Without it export still works, on a slower single-threaded encoder |
| Access control | Settings → General → **Visibility** → **Private** | Yes | Studio's API rules carry no per-rule auth, so this is the only thing protecting the paid AI endpoints. Once Private, an **Access Control** card appears where you can set **Required Role** to **Admin or higher** |
| `HF_TOKEN` secret | Settings → AI → **Secrets** ([get one](https://huggingface.co/settings/tokens)) | Optional | **Speaker diarization** only — labelling who is talking. Transcription works without it |

The diarization model on Hugging Face is **gated**: beyond creating a token, you must visit the
model page and accept its terms once, or diarization fails with no clear error.

Voice cloning costs roughly **$3 per call**; everything else is metered Replicate usage.

## Check it works

Upload a short screen recording and wait for the transcript. That one round-trip exercises the
presigned upload, your bucket, and the WhisperX transcribe pipeline.

A 404 on `/api/*` means the proxy rule sets are not attached to the app's alias. A transcribe
failure usually means a missing Replicate token.

## Advanced (optional)

Neither of these is needed to get Studio running.

**Better thumbnail prompts.** In Proxy Rules, open the `thumbnail-draft` rule → its AI step →
Skills, and set Skills Path to `apps/studio/dist/bffless/skills` to load the `image-prompts`
skill, which defines the house styles, style routing, and negatives. Leave **Skills Source
(Alias)** on **Auto (serving deployment)** — skills already resolve against the deployment
serving the request, which is Studio. Without this the thumbnail drafter still returns a prompt,
just a generic one; the skill is skipped silently. Note the path is stored **per project**, so
setting it once on this step applies to every AI step.

**Sharing a project with other apps.** Scope access control to the `studio` alias (Aliases →
`studio` → Private) instead of making the whole project private, which cascades to every alias
and domain in it. Be aware that the Skills Path and the cross-origin header rule are project-wide
and cannot be scoped per app.

## Going deeper

- [`bffless/README.md`](./bffless/README.md) — the proxy rule sets: authoring, building, importing, attaching
- [`GETTING-STARTED.md`](../../GETTING-STARTED.md) — deploying an app from source, for forkers
- [`CLAUDE.md`](./CLAUDE.md) — local development commands and the locked pipeline
- [`CONTEXT.md`](./CONTEXT.md) and [`DESIGN.md`](./DESIGN.md) — domain model and design decisions
- [`stories/`](./stories/) — the design, story by story. Read `00-architecture-and-state.md` first
