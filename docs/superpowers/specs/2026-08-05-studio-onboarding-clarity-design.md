# Studio onboarding clarity — design

**Date:** 2026-08-05
**Status:** approved, not yet implemented
**Repos touched:** `bffless/ce` (piece 1), `bffless/apps` (pieces 2 and 3)

## Problem

Setting Studio up on a fresh CE instance sends the operator to the wrong place, twice, and
demands a credential they probably do not need.

The project Settings → **AI** tab stacks four cards:

| # | Card | Backing column | What it holds |
| --- | --- | --- | --- |
| 1 | **AI Settings** | `projects.ai_providers` | OpenAI / Anthropic / Google API keys |
| 2 | AI Plugins | — | chat tool toggles |
| 3 | **AI Services** | `projects.ai_services` | the Replicate API token |
| 4 | Secrets | `project_secrets` | generic named secrets |

Cards 1 and 3 have near-identical names, adjacent placement, and unrelated contents. Neither
name says what it actually holds:

- **"AI Services"** is Replicate and only Replicate. `AIServiceType` is a single-member union
  (`apps/backend/src/projects/project-ai-settings.service.ts:13-16`), the dialog inside is
  already titled "Add Replicate", and the header button hides itself once a token exists. The
  generic framing hides the one thing the card does.
- **"AI Settings"** is where the Anthropic key goes, but nothing on the card says "Anthropic",
  and its subtitle — *"Configure AI providers for chat pipelines"* — is narrower than the truth.
  Those keys feed `ai_handler`, which runs in both `chat` and `completion` mode
  (`apps/backend/src/pipelines/handlers/ai.handler.ts`). Studio's Anthropic uses are
  completion-mode: thumbnail prompt drafts and the blog writer. An operator debugging a broken
  thumbnail draft has no reason to look at a card labelled "chat".

Studio's own install copy inherits the confusion and adds to it. In
`apps/studio/bffless-app.json`:

- `connect-anthropic` says *"under Settings → AI Services"* — the wrong card. Anthropic is not a
  valid `AIServiceType`.
- `add-hf-token` says *"Settings → AI Services → Secrets"* — Secrets is a sibling card, not a
  child of AI Services.
- `add-hf-token` is presented as unconditional, and blames *"WhisperX alignment/diarization"*.

That last one is the costly error. `HF_TOKEN` appears exactly once in Studio's entire rule set —
`POST /api/transcribe`, post-step `whisper`:

```yaml
handlerType: replicate
model: victor-upmeet/whisperx
input:
  align_output: true
  diarization: steps.prep.diarize        # per-request flag
  huggingface_access_token: secrets.HF_TOKEN
```

`align_output` runs unconditionally and needs no token — only diarization does, because pyannote
is a gated Hugging Face repo. `diarize` is a user-facing toggle
(`src/components/Studio/SourceQueue.tsx:296`) that defaults to **off**
(`src/store/studioSlice.ts:237`). A missing secret resolves to `null` rather than throwing
(`apps/backend/src/pipelines/execution/expression-evaluator.ts:194`), so single-narrator
transcription — Studio's default path — works with no Hugging Face token at all. Today every new
user is told to go get one before they can transcribe.

Finally, `apps/studio/` has no `README.md`, so the GitHub page for the app renders bare. The
setup material that does exist is one directory down in `apps/studio/bffless/README.md`, under a
title that reads as backend internals, and it repeats all three inaccuracies above.

## Non-goals

- No backend, schema, or API change. `addOrUpdateService` is already an upsert; `ai_providers`
  and `ai_services` keep their columns and endpoints.
- No second AI service provider. "AI Services" is renamed *because* it is Replicate-only; if a
  second one is ever added this decision is revisited.
- No deep-link anchors on the AI tab (a manual step's **Go** still lands at the top of the tab).
  Considered and deferred — it is a feature, not copy.
- **The installer does not create response-header rules.** Considered and rejected, not deferred:
  header rules are scoped to the *project*, not the app (see Piece 4), so an installer that
  created a `**` COOP/COEP rule on Studio's behalf would silently change header behaviour for
  every other app sharing that project.
- `apps/studio/bffless/README.md` is **not** moved, restructured, or deleted. It stays the
  technical rule-set reference; only its three factual errors are corrected.

---

## Piece 1 — CE: name the two cards for what they hold

Ships first: pieces 2 and 3 quote these section names, so they are wrong until this lands.

All changes are in `apps/frontend/src/components/project/ProjectAISettingsTab.tsx`.

### Card 1 — `AI Settings` → `LLM Providers`

| Line | Now | After |
| --- | --- | --- |
| 924 | `AI Settings` | `LLM Providers` |
| 927 | `Configure AI providers for chat pipelines in this project.` | `API keys for OpenAI, Anthropic, and Google. Used by any AI step in your pipelines — chat and one-off text generation.` |
| 964 | `No AI providers configured` | `No LLM providers connected` |
| 967 | `Add an AI provider to enable chat pipelines and AI-powered features for this project.` | `Add a provider — Anthropic, OpenAI, or Google — to enable AI steps in this project's pipelines.` |
| 640 | `Add AI Provider` | `Add LLM Provider` |
| 642 | `Configure a new AI provider for this project's chat pipelines.` | `Choose a provider and paste its API key.` |

The **`Add Provider`** button keeps its label — the manifest and README point at it by name.
The `Bot` icon is unchanged.

### Card 3 — `AI Services` → `Replicate`

| Line | Now | After |
| --- | --- | --- |
| 153 | `AI Services` | `Replicate` |
| 156 | `Configure external ML services for pipeline steps.` | `Your Replicate API token. Powers ML model steps: transcription, image generation, and embeddings.` |
| 210 | `No AI services configured` | `Replicate not connected` |
| 213 | `Add an AI service to enable Replicate ML model pipelines.` | `Connect Replicate to enable transcription, image generation, and vector-search steps.` |
| 162, 217 | `Add Service` | `Connect Replicate` |
| 184 | inner `meta.description` row | removed — it now duplicates the card subtitle |

The dialog copy (`Add Replicate`, the `r8_...` placeholder, the
`replicate.com/account/api-tokens` link) is already correct and is untouched. The `Zap` icon is
unchanged.

### Behavioural fix — a configured token can be replaced

Line 159 renders the header button only `{!hasReplicate && ...}`, so once a token exists there is
no way to swap a rotated one short of remove-then-add. The header button becomes unconditional:

- no token → **`Connect Replicate`**
- token present → **`Replace token`**

Both open the existing dialog. No backend change: `addOrUpdateService`
(`project-ai-settings.service.ts:813-854`) already upserts on `service`.

### Dangling references

Two strings name a card that will no longer exist. Both are corrected in the same change:

| File | Now | After |
| --- | --- | --- |
| `apps/backend/src/pipelines/handlers/replicate.handler.ts:64-79` | `Replicate API token is not configured. Add it in Settings > AI > AI Services.` | `Replicate API token is not configured. Add it in Settings > AI > Replicate.` |
| `apps/backend/src/pipelines/ai-plugins/plugins/rag-search.plugin.ts:106` | `Vector search requires Replicate in AI Services.` | `Vector search requires a Replicate token (Settings → AI → Replicate).` |

### Verification

- `pnpm --filter frontend exec tsc --noEmit`
- `pnpm --filter backend exec tsc --noEmit`
- Frontend component test asserting `LLM Providers` and `Replicate` headings render, and that
  the Replicate header button reads `Replace token` when a service is configured.
- `pnpm lint` already fails on `main` independently of this change — compare against a
  pre-change baseline rather than treating the count as a regression.

Work happens in a worktree branched from `origin/main`. The shared `repos/ce` checkout is 26
commits behind and must not be branched from.

---

## Piece 4 — CE: a Cross-Origin Isolation preset

Ships with Piece 1. Today the COOP/COEP step asks an operator to hand-type two header names and
two values they have no way to guess — the single worst step in Studio's install.

`apps/frontend/src/components/project/ProjectResponseHeaderRulesTab.tsx` already has a
**Quick Start (Presets)** row (`Embed Widget`, `Block Framing`) backed by the `presets` array at
line 70. Two changes:

1. **Let presets carry custom headers.** `applyPreset` (line 152) hardcodes
   `setCustomHeaderRows([])`. It becomes `setCustomHeaderRows(preset.customHeaders ?? [])`, and
   the preset objects gain an optional `customHeaders: { name, value }[]`.
2. **Add a third preset:**

   | Field | Value |
   | --- | --- |
   | name | `Cross-Origin Isolation` |
   | pathPattern | `**` |
   | framePolicy | `sameorigin` |
   | customHeaders | `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless` |
   | description | `Enable SharedArrayBuffer for multithreaded WebAssembly (in-browser video export)` |

`sameorigin` is the existing default (`defaultFrameAncestors` CSP, and nginx already emits
`X-Frame-Options: SAMEORIGIN` globally), so the preset changes nothing about framing. These
exact header values are already canon in CE — `apps/backend/src/mcp/tools/response-header-rules.tools.ts:71`
documents the same recipe for the MCP tool.

Frontend only, no backend change. Verified with a component test asserting the preset populates
both custom-header rows.

### Scope caveat — header rules are project-wide

`ResponseHeaderConfigService.getHeaderConfig(projectId, filePath)` caches and matches rules **per
project**, by a picomatch glob over the deployment file path (`response-header-config.service.ts:68-101`).
There is no alias, domain, or per-app dimension. A `**` rule therefore applies to *every*
deployment in the project — and the monorepo convention puts all apps in one project, so
Studio's COOP/COEP rule would also apply `COEP: credentialless` to Handoff, which can break
cross-origin subresources served without CORP.

**The preset uses `**` and does not attempt to scope.** It is a generic CE control offered to
every project, so it cannot carry an app-specific prefix like `apps/studio/dist/**` — that would
be meaningless to anyone not installing Studio. `**` is also correct for the single-app project,
which is what a first-time installer has.

The path field stays editable, so an operator running several apps in one project can narrow it
by hand. The README says so, and warns that as written the rule is project-wide. No further
investigation needed — this is a deliberate choice, not an open question.

---

## Piece 5 — CE: clickable links in manual steps

Ships with Piece 1. `SetupNotes.tsx:66` renders `step.body` as plain text in a `<p>` — no
markdown, no linkification — and the only anchor is `deepLink`, which points into the admin
panel. So a manual step cannot send an operator to an external page to *obtain* a credential.
`huggingface.co/settings/tokens` appears nowhere in CE (zero hits across frontend and backend);
it exists only in `apps/studio/bffless/README.md` and the `install-app` skill.

Add an optional external link to the manual-step contract:

```ts
export interface AppManualStep {
  id: string;
  title: string;
  body: string;
  deepLink?: string;
  externalLink?: { label: string; url: string };   // new
  appliesWhen?: AppliesWhen;
}
```

- **Validation** (`app-manifest.util.ts`, `validateManualSteps`): if present, must be a plain
  object with non-empty `label` and `url`; `url` must be `https://`. Placeholder validation is
  not applied — these are literal external URLs.
- **Render** (`SetupNotes.tsx`): a second anchor beside the existing `Go` link, labelled from
  `externalLink.label`, with `target="_blank" rel="noopener noreferrer"`.
- **Frontend type** (`appCatalogApi.ts`) mirrors the backend interface.

Chosen over linkifying URLs inside `body` because it keeps the body prose clean and gives the
link an explicit label.

**Compatibility:** `validateManualSteps` checks known fields and does not reject unknown ones, so
a manifest carrying `externalLink` still installs on an older CE — the link is simply not
rendered. The apps-side linter (`scripts/check-app-conventions.mjs:226`) only scans
`title`/`body`/`deepLink` for placeholder tokens and needs no change. No `ceMin` bump required.

Studio's `add-hf-token` step then carries:

```json
"externalLink": { "label": "Get a Hugging Face token", "url": "https://huggingface.co/settings/tokens" }
```

---

## Piece 2 — Studio manifest: point the steps at real places

`apps/studio/bffless-app.json`, the `install.manualSteps` array.

`appliesWhen` is a closed set — `always | bucketStorage | localStorage | platformMode |
selfHosted` (`apps/backend/src/app-catalog/app-manifest.types.ts`). There is no "optional
feature" condition, so the HF_TOKEN step stays `always` and carries its conditionality in the
title and body.

**`connect-replicate`** — retitled for the renamed card:

> **Connect Replicate**
> Add your Replicate API token under Settings → AI → Replicate. It powers transcription
> (WhisperX), scene direction and the per-scene refiner (Gemini), voice clone and speech
> (MiniMax — cloning ≈ $3 per call), and thumbnail rendering.

**`connect-anthropic`** — corrected card, and both models named:

> **Connect Anthropic**
> Add an Anthropic API key under Settings → AI → LLM Providers → Add Provider. It powers
> thumbnail prompt drafts (Claude Sonnet) and the companion blog writer (Claude Opus).

**`add-hf-token`** — demoted to optional, and the alignment claim dropped:

> **Optional: HF_TOKEN for speaker diarization**
> Optional — transcription works fine without it. It is needed only to support **speaker
> diarization**, which labels who is talking in a recording with more than one voice. To enable
> it, create a secret named `HF_TOKEN` with a Hugging Face read token under
> Settings → AI → Secrets; diarization runs a gated Hugging Face model that requires the token.

The word "Optional" leads both the title and the body deliberately — an operator scanning the
step list must be able to skip it without reading further.

**`coop-coep-headers`** — rewritten around the new preset (Piece 4), replacing the instruction to
hand-type two headers:

> **Turn on cross-origin isolation**
> Settings → Response Headers → Add Rule → click the **Cross-Origin Isolation** preset → Create.
> Studio's in-browser video export needs it; without it, export falls back to a slower
> single-threaded encoder.

**`restrict-access`** — the current `deepLink` is `?tab=members`, which is people management and
has no visibility control at all. Corrected to `?tab=general`, and the body now names the two
controls using the screen's own words — **Visibility** (a switch reading `Public`/`Private`) and
**Access Control** (the card that appears only once Private, holding `Required Role`, whose
literal admin option is `Admin or higher`):

> **Keep Studio private**
> Studio's API rules carry no per-rule auth, so access control is the only thing protecting the
> paid AI endpoints. Under Settings → General → **Visibility**, set it to **Private**. An
> **Access Control** section then appears — optionally set **Required Role** to
> **Admin or higher**.

`deepLink` becomes `/repo/{projectPath}/settings?tab=general`.

**`add-hf-token`** additionally gains the `externalLink` from Piece 5.

**`point-skills-path`** — **removed from `manualSteps` entirely.** It is not required to get Studio
working, and half its instruction is wrong.

The rule already pins its skill selection in the pipeline —
`.bffless/proxy-rules/studio/rules/api/thumbnail/draft/post/rule.yaml:18-21` carries
`skills: { mode: selected, enabled: [image-prompts] }`. What the rule does *not* carry is where
skills are read from, and that is **project-level**, not per-rule:

| Setting | Stored at | Default | Needed? |
| --- | --- | --- | --- |
| Source (alias) | `project.settings.skillsAlias` | unset → falls back to the deployment serving the request (`ai.handler.ts:329-335`) | **No.** The serving deployment *is* Studio, so setting it is redundant. It matters only when skills live in a different deployment. |
| Path | `project.settings.skillsPath` | `.bffless/skills` (`project-ai-settings.service.ts:677-685`) | Yes, for the house styles — Studio's skills are at `apps/studio/dist/bffless/skills` because of `basePath: /apps/studio/dist`. |

`skillsPath` is one value per project — the **third** project-wide setting in this install, after
the COOP/COEP rule (Piece 4) and visibility (above). Two apps in one project with different skill
layouts cannot both resolve.

It degrades silently rather than failing: a wrong path makes `listSkills` return nothing,
`enabledSkills` is empty, and `ai.handler.ts:374-375` catches and continues. The model still
returns a valid-looking prompt — just without the house styles, style routing, and negatives from
`SKILL.md`. Nothing in the output reveals the skill was skipped, which is why it can appear to
work while quietly producing worse thumbnails.

**Noted, not filed** (no CE issue per instruction): a rule that enables skills which resolve to
zero at the configured path should surface a pipeline warning rather than a debug log. The manual
step was a workaround for that silence.

### Caveat — Private at the project level cascades

Visibility is a three-level cascade: domain override → alias → project
(`apps/backend/src/domains/visibility.service.ts:34-37`), with `projects.is_public` defaulting to
`true` and alias/domain `is_public` nullable overrides meaning "inherit".

Flipping the **project** to Private therefore makes *every* alias and domain in it private by
inheritance — including other apps sharing that project. This is the same project-scoping trap as
the COOP/COEP rule in Piece 4. The scoped alternative is the per-alias control at
`/repo/{projectPath}/aliases`, where the `studio` alias alone can be set to `Private`
(`AliasesTab.tsx:118-170`, options `Inherit from project` / `Public` / `Private`).

The manifest step keeps the project-level instruction — correct for the single-app project a
first-time installer has — and the README carries the alias-scoped alternative for anyone
running several apps in one project. There is no per-project deep link for the domain-level
control; `/domains` is a global admin page.

`deepLink` values (`/repo/{projectPath}/settings?tab=ai`) are unchanged and already correct;
`coop-coep-headers` keeps `?tab=response-headers`.

Manifest bodies are linted against `PLACEHOLDER_TOKENS` by
`scripts/check-app-conventions.mjs`; these edits introduce no new tokens.

**Reach:** manifests are fetched from the registry at install time and are not vendored into CE,
so corrected copy reaches an instance only on the next Studio release/reinstall. It does not fix
an already-installed instance.

---

## Piece 3 — `apps/studio/README.md`

New file. The front door for someone who has just installed Studio and wants it working — plain
language, no rule-set internals. No app in the monorepo has a top-level README today, so this
sets the pattern.

**Voice:** written for an operator, not a contributor, and **short** — the existing
`bffless/README.md` is good reference material for an agent but too verbose for a human, which
is exactly the failure this file must not repeat. Target one screen of prose plus the table.
The table does the work; no expanding paragraph per row. Anything that needs more than a
sentence of explanation belongs in `bffless/README.md`, linked.

Outline:

1. **What Studio is** — three sentences, adapted from `catalog/description.md`.
2. **Setup** — the core, and the only long section. One row per thing to configure:

   | What | Where | Required? | What it powers |
   | --- | --- | --- | --- |
   | Replicate token | Settings → AI → **Replicate** | Yes | transcription (WhisperX), scene direction + refiner (Gemini), voice clone/speech (MiniMax), thumbnail render |
   | Anthropic key | Settings → AI → **LLM Providers** → Add Provider | For thumbnails + blog | thumbnail prompt drafts (Sonnet), blog writer (Opus) |
   | `HF_TOKEN` secret | Settings → AI → **Secrets** ([get one](https://huggingface.co/settings/tokens)) | **Optional** | **Speaker diarization** only — labelling who is talking on `/api/transcribe`. Transcription works without it. |
   | Storage bucket | Settings → Storage | Yes | presigned uploads; writes under `<owner>/<repo>/uploads/…` |
   | Cross-origin isolation | Settings → Response Headers → **Cross-Origin Isolation** preset | Yes for fast export | `SharedArrayBuffer` for multithreaded `ffmpeg.wasm` |
   | Access control | Settings → **General** → Visibility → **Private** (then Access Control → Required Role) | Yes | Studio's rules carry no per-rule auth — this is the only thing protecting paid AI endpoints. Sharing a project with other apps? Scope it to the `studio` alias instead, under Aliases. |

   The "where" cells carry the link to obtain each credential. No prose beneath the table
   except one line on cost: voice cloning ≈ $3/call, everything else is metered Replicate usage.
3. **Check it works** — one paragraph. Upload a short screen recording, see the transcript
   return. A 404 on `/api/*` means the rule sets are not attached to the alias; a transcribe
   failure usually means a missing Replicate token.
4. **Advanced (optional)** — two short items, explicitly marked as not needed to get running:
   - **Better thumbnail prompts.** Settings → AI → Skills Path: set it to
     `apps/studio/dist/bffless/skills` to load the `image-prompts` skill (house styles, style
     routing, negatives). Leave **Source** blank — it defaults to the deployment serving the
     request, which is already Studio. Without this, thumbnail drafting still returns a prompt,
     just a generic one; the skill is skipped silently. Note this is a per-project setting.
   - **Sharing a project with other apps.** Scope access control to the `studio` alias rather
     than the whole project (Aliases → `studio` → Private), and be aware that the Skills Path
     and the cross-origin header rule are project-wide.
5. **Going deeper** — a link list, one line each: `bffless/README.md` (rule-set authoring,
   import, local dev commands), `CONTEXT.md`, `DESIGN.md`, `stories/`.

### Corrections to `apps/studio/bffless/README.md`

Kept as the technical reference; only the statements that contradict the new README are fixed:

| Line | Now | After |
| --- | --- | --- |
| 63-65 | `HF_TOKEN` under `Settings → AI Services → Secrets`, *"WhisperX alignment/diarization requires it"* | `Settings → AI → Secrets`; optional, required only when the speaker-diarization toggle is on |
| 85 | `under AI Services → Replicate` | `under Settings → AI → Replicate` |
| 90 | `under Secrets (just below AI Services)` | `under Settings → AI → Secrets` |
| 93-94 | Anthropic key `under AI Services` | `under Settings → AI → LLM Providers → Add Provider`; note the blog writer uses `claude-opus-4-6` alongside `claude-sonnet-4-6` for thumbnail drafts |
| 130-131 | *"a transcribe failure usually means a missing Replicate token or `HF_TOKEN`"* | drop `HF_TOKEN` — it cannot cause a default-path transcribe failure |
| 76-79 | *"AI skills path — the `thumbnail-draft` rule's `ai` step Skills section. Set Skills Source to `studio` and Path to …"* | drop the Source instruction (redundant — falls back to the serving deployment); keep Path only, marked optional, and note it is a per-project setting |

`catalog/description.md:25-27` also lists `HF_TOKEN` among required credentials; it is reworded
to mark it optional.

---

## Sequencing

1. Pieces 1, 4, 5 (CE) — one PR: card renames, the Cross-Origin Isolation preset, and
   `externalLink` on manual steps. Merge and deploy first; everything downstream quotes the new
   section names, the new preset, and the new manifest field.
2. Pieces 2 and 3 (apps) — one PR; the manifest and the READMEs must agree.

No open questions.

Piece 2's corrected copy reaches an installed instance only on the next Studio release, so the
README is the surface that helps the current onboarding run.
