# Studio backend — BFFless proxy rule set

Studio has no app server. Its `/api/*` endpoints are a **BFFless proxy rule set** (handler chains:
presigned uploads, file serving, Replicate calls, data tables, signed URLs). To run Studio against
your own BFFless project you import that rule set and attach it to the alias serving the app.

[`studio.proxy-rules.json`](studio.proxy-rules.json) is the exported rule set (43 rules, format
`bffless-proxy-rule-set` v1). It contains **no secrets** — credentials are referenced by name
(`secrets.HF_TOKEN`) or use the project's configured provider tokens.

## Import

**Dashboard:** BFFless project → Proxy Rules → **Import** → upload `studio.proxy-rules.json`.

**Claude / MCP:** ask Claude (with the BFFless MCP connected) to import
`apps/studio/bffless/studio.proxy-rules.json` into your project. It creates the `studio` rule set and
all 43 rules (IDs are remapped on import).

After import, **attach the `studio` rule set to the alias** your deploy uploads to (e.g. the `studio`
alias / `studio.<your-domain>`). `/api/*` only serves on aliases the rule set is attached to.

## Prerequisites (provision these in the target project first)

In the BFFless dashboard → **Settings → AI**:

1. **Replicate token** — under **AI Services → Replicate**, create an API token at
   [replicate.com](https://replicate.com/account/api-tokens) and paste it. Powers
   `victor-upmeet/whisperx` (transcribe), `google/gemini-3.1-pro` (director / refiner / describe /
   search), `minimax/voice-cloning` + `minimax/speech-2.8-turbo` (voice), and `google/nano-banana-2`
   (thumbnail render).
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
set, so it is *not* in `studio.proxy-rules.json`). Without it, `getFFmpeg()` silently falls back to
the single-threaded core (slower, 2 GiB cap) — you'll see `ffmpeg core: single-threaded` in the
console.

Add this once per project (BFFless dashboard → Settings → Response Headers, or via MCP
`create_response_header_rule`):

- **Path pattern:** `**`
- **Headers:** `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`

After adding it, hard-reload the deployment; the console should report the multithreaded core.

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
edits. **If you re-export from your own project, keep this pattern** (don't let it bake in your
project name). `deployment.owner`/`deployment.repo` are listed in the step editor's *Available
Variables*; if a transcribe or thumbnail call 404s on a `storage.googleapis.com/.../uploads/` GET,
confirm the function received `deployment` (not a template-only value).

## Notes

- **Validators are intentionally off.** `auth_required` + `rate_limit` are not set on these rules
  (deferred to story 07) so unauthenticated local dev works. Add them before exposing a paid/public
  deployment.
- **Voice cloning costs ~$3/call** (`/api/voice/clone`). It's enabled in this export.
- Re-export from the BFFless dashboard (Proxy Rules → Export) after changing rules, and commit the
  updated JSON here so the giveaway stays current.
