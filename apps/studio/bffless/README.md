# Studio backend — BFFless proxy rule set

Studio has no app server. Its `/api/*` endpoints are a **BFFless proxy rule set** (handler chains:
presigned uploads, file serving, Replicate calls, data tables, signed URLs). To run Studio against
your own BFFless project you import that rule set and attach it to the alias serving the app.

Studio's backend is **two sibling rule sets**, both **authored** under
[`apps/studio/.bffless/proxy-rules/`](../.bffless/proxy-rules/) (`ruleset.yaml` + a `rules/` file per
route + schemas) — that's the source of truth, not a committed JSON export. **No secrets** —
credentials are referenced by name (`secrets.HF_TOKEN`) or use the project's configured provider
tokens:

- [`studio/`](../.bffless/proxy-rules/studio/) — the main `studio` set (40 rules): uploads,
  transcribe, director, refiner, voice, thumbnail, projects/jobs.
- [`studio-blog/`](../.bffless/proxy-rules/studio-blog/) — the `studio-blog` set (4 rules): the
  companion blog-post writer (`POST /api/blog`) + blog image uploads
  (`/api/uploads/blog/{prepare,register,*}`).

## Import

On this repo's own deploys, CI syncs both authored sets straight to the `bffless/apps` project via
`bffless/deploy-proxy-rules` — nothing to import by hand. Check for local drift any time with
`npx bffless rules diff`.

**Installing into your own project** (your fork's CI isn't wired to your instance yet, or you're doing
a one-off import): build the import JSON from the authored source, one set at a time:

```bash
npx bffless rules build apps/studio/.bffless/proxy-rules/studio -o /tmp/studio.proxy-rules.json
npx bffless rules build apps/studio/.bffless/proxy-rules/studio-blog -o /tmp/studio-blog.proxy-rules.json
```

**Dashboard:** BFFless project → Proxy Rules → **Import** → upload `studio.proxy-rules.json`, then
repeat for `studio-blog.proxy-rules.json`.

**CLI:** `npx bffless rules push apps/studio/.bffless/proxy-rules/studio` (and again for
`studio-blog`) pushes straight to your project, skipping the manual build/import round-trip. (The
repo's committed `.bffless/config.json` targets the upstream demo instance — point the push at your
own with `--api-url <your-instance> --project <owner/name>` and your `BFFLESS_API_KEY`.)

**Claude / MCP:** ask Claude (with the BFFless MCP connected) to import both built JSON files into
your project. It creates the `studio` and `studio-blog` rule sets and all their rules (IDs are
remapped on import).

After import, **attach BOTH rule sets to the alias** your deploy uploads to (e.g. the `studio`
alias / `studio.<your-domain>`) — aliases accept multiple rule sets and merge their rules. `/api/*`
only serves on aliases the rule sets are attached to.

## Manual setup (admin panel)

Everything the human must configure in the BFFless admin panel that the `install-app` skill
**cannot** do. The repo-root [`GETTING-STARTED.md`](../../../GETTING-STARTED.md) spine points here for
Studio's app-specifics; do them once in the target project (all monorepo apps share one project, so
provider tokens/secrets are set per project, not per app).

- **External connections / AI provider tokens — Replicate + Anthropic (admin-panel only, no MCP).**
  Studio's AI pipelines need a **Replicate** token (powers `victor-upmeet/whisperx` transcribe,
  `google/gemini-3.1-pro` director, `google/gemini-3.5-flash` refiner, `minimax/*` voice,
  `google/nano-banana-2` thumbnail) and
  an **Anthropic** key (`claude-sonnet-4-6` for `/api/thumbnail/draft`). See
  [Prerequisites](#prerequisites-provision-these-in-the-target-project-first) §1 and §3 for where to
  obtain and enter each.
- **Secrets — `HF_TOKEN` from Hugging Face.** Add `HF_TOKEN` under **Settings → AI Services → Secrets**
  set to a [Hugging Face](https://huggingface.co/settings/tokens) **read** token; `/api/transcribe`
  references it as `secrets.HF_TOKEN` for WhisperX alignment/diarization. See Prerequisites §2.
- **Storage backend — a default bucket is required.** Studio uploads/serves write under
  `<owner>/<repo>/uploads/<kind>/…`, so the project needs a storage backend with a default bucket for
  uploads; also provision the `studio_jobs` + projects data tables. See the
  [Prerequisites](#prerequisites-provision-these-in-the-target-project-first) table.
- **Response-header rules — COOP/COEP for `ffmpeg.wasm` threading.** Studio's Export step needs the
  page **cross-origin isolated**, which is a response-header rule *not* in the proxy-rules JSON. See
  [Cross-origin isolation](#cross-origin-isolation-required-for-ffmpeg-threading) below.
- **Keep the domain private** — Studio's rules carry no per-rule auth; the
  non-public domain (optionally `requiredRole: admin`) is what gates the paid
  AI endpoints.
- **AI skills path — the `thumbnail-draft` rule's `ai` step Skills section.** Set Skills Source to
  `studio` and Path to `apps/studio/dist/bffless/skills` so `/api/thumbnail/draft` can load the
  `image-prompts` skill; without this pairing thumbnail drafting silently skips the skill (the
  installer can't wire it).

## Prerequisites (provision these in the target project first)

In the BFFless dashboard → **Settings → AI**:

1. **Replicate token** — under **AI Services → Replicate**, create an API token at
   [replicate.com](https://replicate.com/account/api-tokens) and paste it. Powers
   `victor-upmeet/whisperx` (transcribe), `google/gemini-3.1-pro` (director / describe / search),
   `google/gemini-3.5-flash` (refiner), `minimax/voice-cloning` + `minimax/speech-2.8-turbo` (voice),
   and `google/nano-banana-2` (thumbnail render).
2. **`HF_TOKEN` secret** — under **Secrets** (just below AI Services), add `HF_TOKEN` set to a
   [Hugging Face](https://huggingface.co/settings/tokens) **read** token. Used by `/api/transcribe`
   for WhisperX alignment/diarization (when diarization is enabled). Referenced as `secrets.HF_TOKEN`.
3. **Anthropic key** — under AI Services, for the `/api/thumbnail/draft` `ai_handler`
   (`claude-sonnet-4-6`).

Also:

| Need | Why |
| --- | --- |
| **Storage backend** (default bucket) | Uploads/serves write under `<owner>/<repo>/uploads/<kind>/…` sub-dirs (`source/`, `audio/`, `voice/`, `narration/`, `scene-clip/`, `export/`, `thumbnails/`, …) — created on demand. |
| **Data tables** for `studio_jobs` + projects | The async job poll (`/api/studio/job`) and `/api/projects*` use BFFless data handlers. |

## Cross-origin isolation (required for ffmpeg threading)

The export's `/api/*` proxy rules are the backend, but Studio's **Export** step assembles video with
multithreaded `ffmpeg.wasm`, which needs `SharedArrayBuffer` — i.e. the page must be
**cross-origin isolated**. That comes from a **response-header rule** (separate from the proxy rule
set, so it is not part of the `studio` rule set source). Without it, `getFFmpeg()` silently falls back to
the single-threaded core (slower, 2 GiB cap) — you'll see `ffmpeg core: single-threaded` in the
console.

Add this once per project (BFFless dashboard → Settings → Response Headers, or via MCP
`create_response_header_rule`):

- **Path pattern:** `**`
- **Headers:** `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`

After adding it, hard-reload the deployment; the console should report the multithreaded core.

## First-success checkpoint

Once the rule set is imported and attached, the provider tokens are set, and Studio is deployed
(see the repo-root [`GETTING-STARTED.md`](../../../GETTING-STARTED.md)), confirm the install with one
end-to-end action:

**Upload a short screen recording → see the transcript come back.**

That round-trip exercises the presigned upload, bucket storage, and the WhisperX transcribe pipeline
(`/api/transcribe`). If the transcript renders, Studio's backend is live. A 404 on `/api/*` means the
rule set isn't attached to the `studio` alias; a transcribe failure usually means a missing Replicate
token or `HF_TOKEN`.

## Portability: storage paths are deployment-relative

The custom functions that rebuild a bucket storage path (transcribe, `/api/uploads/sign`, thumbnail,
…) derive the project prefix from the deployment context rather than hard-coding it:

```js
function handler({ request, deployment }) {
  // …
  var storagePath = deployment.owner + '/' + deployment.repo + '/uploads/' + key
}
```

So an import into `you/your-app` writes to `you/your-app/uploads/…` automatically — no per-project
edits. **If you customize these functions in your own project, keep this pattern** (don't let it bake
in your project name). `deployment.owner`/`deployment.repo` are listed in the step editor's *Available
Variables*; if a transcribe or thumbnail call 404s on a `storage.googleapis.com/.../uploads/` GET,
confirm the function received `deployment` (not a template-only value).

## Notes

- **Validators are intentionally off.** `auth_required` + `rate_limit` are not set on these rules
  (deferred to story 07) so unauthenticated local dev works. Add them before exposing a paid/public
  deployment.
- **Voice cloning costs ~$3/call** (`/api/voice/clone`). It's enabled in this export.
- Edit the rule files under `apps/studio/.bffless/proxy-rules/<set>/` directly — whichever set changed
  (`studio` or `studio-blog`) — and commit. CI syncs the change to the project on deploy
  (`bffless/deploy-proxy-rules`); check for drift with `npx bffless rules diff`.
