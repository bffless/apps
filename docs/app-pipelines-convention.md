# Per-app pipelines convention

Every app in this monorepo is installable by the single [`GETTING-STARTED.md`](../GETTING-STARTED.md)
guide. That only stays true if every app ships the same two files in the same place — so the guide's
spine can resolve each app's specifics without being rewritten per app, and so the **per-app manual
admin-panel steps are surfaced to the reader for every app**. This convention is enforced in CI
(`.github/workflows/app-conventions.yml` → `scripts/check-app-conventions.mjs`, i.e. `pnpm apps:check`).

## The rule

Every `apps/<app>/` **must ship**:

1. **`apps/<app>/bffless/<app>.proxy-rules.json`** — the app's exported proxy rule set (its backend
   pipelines). No secrets baked in — credentials are referenced by name or via the project's auth
   relay.
2. **`apps/<app>/bffless/README.md`** — with the two required sections below.

### Required README section: "Manual setup (admin panel)"

Everything the human must configure in the BFFless admin panel that the `install-app` skill
**cannot** do. The guide and the skill both point here. Enumerate, for this app:

- **External connections / AI provider tokens** — which providers, what each powers, and the link to
  obtain the token (these are admin-panel-only; there is no MCP path). E.g. Studio: **Replicate**,
  **Anthropic**. Handoff: none.
- **Secrets** — generic project secrets and where the value comes from. E.g. Studio: `HF_TOKEN` from
  Hugging Face. Handoff: none.
- **Storage backend requirements** — state explicitly if the app won't work on local file storage.
  E.g. **Handoff requires a real bucket backend (S3/GCS/Spaces/MinIO), not local file storage**;
  Studio needs a default bucket for uploads.
- **Response-header rules** — any headers not in the proxy-rules JSON. E.g. Studio's COOP/COEP for
  `ffmpeg.wasm` threading. Handoff: none.

### Required README section: "First-success checkpoint"

The concrete end-to-end action the guide ends on for this app. E.g. Studio: upload a recording → see
the transcript; Handoff: upload a file → see it served back.

## Enforcement

`scripts/check-app-conventions.mjs` fails a PR that introduces (or keeps) an `apps/<app>/` directory
missing either file, or whose README lacks either required section heading. The headings are matched
by wording (any heading level, case-insensitive), so a level change is fine but the section must be
present. Run `pnpm apps:check` locally to reproduce CI.
