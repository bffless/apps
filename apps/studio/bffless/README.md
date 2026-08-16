# Studio backend — BFFless proxy rule set

> Setting Studio up for the first time? Start with [`../README.md`](../README.md) — it lists every
> credential and setting in one table. This file is the technical reference for the proxy rule
> sets themselves.

Studio has no app server. Its `/api/*` endpoints are a **BFFless proxy rule set** (handler chains:
presigned uploads, file serving, Replicate calls, data tables, signed URLs). To run Studio against
your own BFFless project you import that rule set and attach it to the alias serving the app.

Studio's backend is **two sibling rule sets**, both **authored** under
[`apps/studio/.bffless/proxy-rules/`](../.bffless/proxy-rules/) (`ruleset.yaml` + a `rules/` file per
route + schemas) — that's the source of truth, not a committed JSON export. **No secrets** —
credentials are referenced by name (`secrets.HF_TOKEN`) or use the project's configured provider
tokens:

- [`studio/`](../.bffless/proxy-rules/studio/) — the main `studio` set (44 rules): uploads,
  transcribe, director, refiner, voice, thumbnail, projects/jobs, server-side video ops.
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
provider tokens/secrets are set per project, not per app). **Locations and required-ness live in one
place, [`../README.md#setup`](../README.md#setup)** — the bullets below add only what's specific to
how the rule sets consume each value.

- **AI provider tokens — Replicate + Anthropic.** Location/required-ness:
  [`../README.md#setup`](../README.md#setup). Replicate powers `victor-upmeet/whisperx`
  (transcribe), `google/gemini-3.1-pro` (director), `google/gemini-3.5-flash` (refiner),
  `minimax/*` (voice), and `google/nano-banana-2` (thumbnail). Anthropic powers
  `/api/thumbnail/draft` (`claude-sonnet-4-6`) and, if you also import `studio-blog`, the
  companion blog writer (`claude-opus-4-6`).
- **`HF_TOKEN` secret.** Location/required-ness: [`../README.md#setup`](../README.md#setup).
  `/api/transcribe` reads it as `secrets.HF_TOKEN` and passes it on as
  `huggingface_access_token`, only when the diarize flag is on.
- **Storage backend.** Location/required-ness: [`../README.md#setup`](../README.md#setup). The
  rules never hard-code a project name — see
  [Portability](#portability-storage-paths-are-deployment-relative) below for how upload paths
  derive from `deployment.owner`/`deployment.repo`.
- **Response-header rule for cross-origin isolation.** Location/required-ness:
  [`../README.md#setup`](../README.md#setup). See
  [Cross-origin isolation](#cross-origin-isolation-recommended-for-faster-ffmpeg-export) below for
  what it does and why it isn't part of the rule-set JSON.
- **Access control.** Location: [`../README.md#setup`](../README.md#setup). Worth restating here
  because it's rule-set-specific: Studio's proxy rules carry no per-rule auth (see
  [Notes](#notes)), so project-level access control is the *only* thing gating the paid AI
  endpoints.
- **AI skills path (optional).** Not a Settings page — it's **Proxy Rules → the `thumbnail-draft`
  rule → its AI step → Skills → Skills Path**, set to `apps/studio/dist/bffless/skills` to load
  the `image-prompts` skill. Leave **Skills Source (Alias)** on **Auto (serving deployment)** —
  skills already resolve against the deployment serving the request. The value is stored
  **per project**, so setting it on this one step applies to every AI step — `/api/describe`
  (Export title + description) loads `video-description` from the same path. Without it, thumbnail
  drafting and the description writer silently skip their skill and fall back to the generic
  defaults baked into their system prompts.

## Prerequisites (provision these in the target project first)

In the BFFless dashboard → **Settings → AI**:

1. **Replicate token** — under **Settings → AI → Replicate**, create an API token at
   [replicate.com](https://replicate.com/account/api-tokens) and paste it. Powers
   `victor-upmeet/whisperx` (transcribe), `google/gemini-3.1-pro` (director / search),
   `google/gemini-3.5-flash` (refiner), `minimax/voice-cloning` + `minimax/speech-2.8-turbo` (voice),
   and `google/nano-banana-2` (thumbnail render).
2. **`HF_TOKEN` secret (optional)** — under **Settings → AI → Secrets**, add `HF_TOKEN` set to a
   [Hugging Face](https://huggingface.co/settings/tokens) **read** token. Used by `/api/transcribe`
   only when speaker diarization is enabled; `align_output` needs no token. Referenced as
   `secrets.HF_TOKEN`. The diarization model is **gated** on Hugging Face: beyond creating the
   token, you must also visit the model page and accept its terms once, or diarization fails with
   no clear error.
3. **Anthropic key (for the Export description, thumbnail drafts and the blog writer)** — under
   **Settings → AI → LLM Providers → Add Provider**, for `/api/describe` (`claude-opus-4-6`, one
   sync completion — not a chat — with the `video-description` skill), `/api/thumbnail/draft`
   (`claude-sonnet-4-6`) and the companion blog writer (`claude-opus-4-6`). Studio's core pipeline
   (upload, transcribe, direct, refine, voice, export video) runs on Replicate and doesn't need it;
   without the key, "Generate description" on the Export step reports an error while chapters,
   script and the video itself are unaffected.

Also:

| Need | Why |
| --- | --- |
| **Storage backend** (default bucket) | Uploads/serves write under `<owner>/<repo>/uploads/<kind>/…` sub-dirs (`source/`, `audio/`, `voice/`, `narration/`, `scene-clip/`, `export/`, `thumbnails/`, …) — created on demand. |

The `studio_jobs` and projects data tables need no separate provisioning — both rule sets ship
their schemas under `schemas/*.schema.yaml`, so importing the rule set creates the tables.

## Cross-origin isolation (recommended for faster ffmpeg export)

The export's `/api/*` proxy rules are the backend, but Studio's **Export** step assembles video with
`ffmpeg.wasm`. When the page is **cross-origin isolated** it can use the multithreaded core
(`SharedArrayBuffer`); this is *not* a hard requirement — without it, `getFFmpeg()` silently falls
back to the single-threaded core (slower, 2 GiB cap) and export still works, same as
[`../README.md`](../README.md#setup) says. You'll see `ffmpeg core: single-threaded` in the console
if isolation hasn't been set up.

Isolation comes from a **response-header rule** (separate from the proxy rule set, so it is not
part of the `studio` rule set source). Add it once per project: **Settings → Response Headers →
Add Rule → click the Cross-Origin Isolation preset → Create.** The preset sets, on path pattern
`**`:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless`

After adding it, hard-reload the deployment; the console should report the multithreaded core.

## Server video ops (optional, CE >= 0.4.25)

Four rules in the `studio` set (`/api/video/{capabilities,slice,concat,extract-audio}`) call CE's
`ffmpeg_handler` to run scene cuts, clip stitching, and audio extraction server-side instead of in
the browser via `ffmpeg.wasm`. The client calls `GET /api/video/capabilities` once per session — a
cheap, synchronous probe that never fails — and only uses the server path when it reports
`server: true`. On CE < 0.4.25 the rule fails to import or the handler type doesn't exist, the probe
comes back non-200, and the client transparently stays on the wasm path it already uses today; no
separate opt-in is required. A `?videoBackend=server|wasm` query param overrides the probe result for
one session, for testing either path deliberately. **No new secrets or provider tokens** — these
rules read/write the same storage bucket as the rest of the set and don't call any external API.

## First-success checkpoint

Once the rule set is imported and attached, the provider tokens are set, and Studio is deployed
(see the repo-root [`GETTING-STARTED.md`](../../../GETTING-STARTED.md)), confirm the install with one
end-to-end action:

**Upload a short screen recording → see the transcript come back.**

That round-trip exercises the presigned upload, bucket storage, and the WhisperX transcribe pipeline
(`/api/transcribe`). If the transcript renders, Studio's backend is live. A 404 on `/api/*` means the
rule set isn't attached to the `studio` alias; a transcribe failure usually means a missing Replicate
token.

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
