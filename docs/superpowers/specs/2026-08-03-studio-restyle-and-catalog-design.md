# Studio restyle + app-catalog publish — design

Date: 2026-08-03
Status: approved (interactive brainstorm + impeccable session)
Scope: `apps/studio` re-theme with light cleanup; publish Studio to the CE app catalog; document required secrets as install manual steps.

Strategic context lives in `apps/studio/PRODUCT.md` (register: product; personality: precise, calm, focused; WCAG AA). This spec is the "how".

## 1. Goals & non-goals

**Goals**

1. Replace the inherited bffless.app landing-site look (taupe paper, terracotta, Fraunces serif, dot-grid, corner brackets) with Studio's own clean identity.
2. Honest semantic token names — no token whose name states a color it doesn't have.
3. Publish Studio to the CE app catalog (apps.bffless.dev registry) like reader and handoff.
4. Surface the required secrets/config (Replicate, Anthropic, `HF_TOKEN`, COOP/COEP headers) as `install.manualSteps` in the manifest.

**Non-goals**

- No structural UX changes: routes, component hierarchy, and workflows stay as-is.
- No dark mode in this pass (tokens are structured dark-ready; dark ships later as a CSS-var flip + tuning).
- No preflight adoption: keep the existing `theme.css` + `utilities.css` import structure and hand-written `box-sizing` reset (enabling preflight risks subtle regressions across ~40 components for no visible gain).

## 2. Visual system

All tokens live in `apps/studio/src/index.css` `@theme`, expressed in OKLCH. Strategy: restrained — neutral chrome, one accent for actions/selection/state only. "The footage is the color."

### 2.1 Token map (old → new)

| Old token | New token | New value (OKLCH) | ~Hex | Role |
|---|---|---|---|---|
| `--color-paper` | `--color-surface` | `oklch(0.985 0.003 300)` | #fafafa +violet whisper | page background |
| — (was white ad hoc) | `--color-surface-raised` | `oklch(1 0 0)` | #ffffff | cards, panels, inputs |
| `--color-paper-deep` | `--color-surface-dim` | `oklch(0.962 0.004 300)` | ≈#f4f4f5 | wells, toolbars, second neutral layer |
| `--color-paper-line` | `--color-line` | `oklch(0.90 0.006 300)` | ≈#e4e4e7 | hairlines, borders |
| `--color-ink` | `--color-ink` | `oklch(0.21 0.012 300)` | ≈#1c1a20 | primary text |
| `--color-ink-soft` | `--color-ink-soft` | `oklch(0.35 0.012 300)` | ≈#3f3d46 | secondary text |
| `--color-ink-mute` | `--color-ink-mute` | `oklch(0.45 0.015 300)` | ≈#55525e | tertiary text — must stay ≥7:1 on `surface` |
| `--color-ink-faint` | `--color-ink-faint` | `oklch(0.72 0.015 300)` | ≈#a3a0ab | disabled/decorative ONLY, never body text |
| `--color-terracotta` | `--color-accent` | Tailwind violet-600 `oklch(0.541 0.281 293.009)` | #7c3aed | primary actions, selection, active state |
| `--color-terracotta-hover` | `--color-accent-hover` | violet-700 `oklch(0.491 0.27 292.581)` | #6d28d9 | hover |
| `--color-terracotta-ink` | `--color-accent-ink` | violet-950 `oklch(0.283 0.141 291.089)` | #2e1065 | accent-colored text on light tints |
| `--color-voice` | `--color-voice` | emerald-700 `oklch(0.508 0.118 165.612)` | #047857 | diff-viewer voiced spans (role unchanged; darkened for AA as text) |
| `--color-voice-ink` | `--color-voice-ink` | emerald-900 `oklch(0.378 0.077 168.94)` | #064e3b | voiced-span emphasis |

Neutrals carry a whisper of violet tint (chroma 0.003–0.015 at hue ~300) so the chrome relates to the accent — deliberately different from Rivulet's plain slate.

### 2.2 Typography

- `--font-sans`: Inter (kept). Headings h1–h3 switch from Fraunces serif to **Inter semibold, tracking −0.01em to −0.02em**, `text-wrap: balance`.
- `--font-serif`: **deleted** (Fraunces + EB Garamond removed from `index.html` Google Fonts link).
- `--font-mono`: JetBrains Mono (kept) — but **only where mono is functional**: timecodes, durations, cut ranges, `.meta-label`. Timecode displays get `font-variant-numeric: tabular-nums`.
- Base: body 17px → **16px**, line-height 1.5, fixed rem scale ~1.125 ratio (product register: no fluid clamp headings).
- Web font requests drop from 3 families to 2 (Inter, JetBrains Mono).

### 2.3 Surfaces, controls, decoration

- **Delete:** body dot-grid `background-image`, `.corner-marks` (class + all usages), `scroll-behavior: smooth` stays.
- **Buttons:** `.pill-cta`/`.pill-ghost` keep their class names (avoids churn) but restyle: `border-radius: 999px → 6px` (`rounded-md` geometry), padding tightened to product scale (~0.5rem 0.875rem), cta = accent fill/white text (hover `accent-hover`), ghost = `line` border + `ink` text (hover: `surface-dim` fill, not full-ink inversion).
- **Radii scale:** controls 6px, cards 8px (`rounded-lg`) with `shadow-sm` on raised cards. No nested cards.
- **`.meta-label`:** stays as micro-label vocabulary but calms: 10px/0.18em → **11px/0.08em**, still uppercase mono, color `ink-mute`.
- **`.container-page`, `.rule`:** unchanged structurally; `.rule` points at `line`.
- **Focus:** every interactive element gets a visible ring — `outline: 2px solid accent; outline-offset: 2px` (or ring utilities matching it). `::selection`: accent bg / white text.
- **Motion:** keep `slide-up`/`anim-in` (150–300 ms, ease-out); add a `@media (prefers-reduced-motion: reduce)` block that collapses both to opacity-only/instant. New — currently missing, required for AA.

### 2.4 Contrast commitments (verified during implementation with a contrast checker)

- `ink`, `ink-soft`, `ink-mute` ≥ 4.5:1 on `surface`, `surface-raised`, `surface-dim` (`ink-mute` targets ≥7:1 headroom).
- `ink-faint` is exempt (decorative/disabled only) — sweep must confirm no body text uses it; violations upgrade to `ink-mute`.
- White on `accent` (violet-600): used only at button size/weight (≥3:1 bold bar). `voice` passes 4.5:1 as span text on light surfaces.

## 3. Component sweep (light cleanup)

Mechanical rename across `apps/studio/src/**/*.tsx` (`bg-paper→bg-surface`, `border-paper-line→border-line`, `bg-terracotta→bg-accent`, `text-terracotta-ink→text-accent-ink`, etc.), plus while in each file:

- Normalize radii/shadows to the scale above; violet focus rings; fix obviously cramped spacing.
- Header (`App.tsx`): `bg-surface/85 backdrop-blur` bar, wordmark from serif to Inter semibold with a small accent mark.
- `StudioStepper`/`StageCard`: inherit the accent rename; StageCard's `border-l-2` active treatment is replaced (side-stripe accent is banned) with a full `border-accent` border or `surface-dim`+accent-text active state — decided at implementation with screenshots.
- Opacity-suffixed usages (`terracotta/10` etc.) map to `accent/10` equivalents.
- No route, state, or component-structure changes. `build`, `lint`, `test:run` must pass; every phase screen validated headless via `localdev-tools/shot.mjs` against `pnpm studio:dev` (mock-driven where auth-gated).

Deliverable alongside code: `apps/studio/DESIGN.md` capturing the new system (tokens, type scale, component vocabulary) per the impeccable convention.

## 4. App-catalog publish

Follows `docs/app-pipelines-convention.md` + the repo `publish-app` skill. New files under `apps/studio/`:

### 4.1 `bffless-app.json` (v1.0.0)

- `schemaVersion: 1`, `id: "studio"`, `name: "Studio"`, `category: "video"` (siblings use simple slugs: `"reading"`, `"files"`), `summary`: one line on cut-first editing of a screen recording in your own voice.
- `requires`: `{ "presignedStorage": true, "ceMin": "0.4.13" }` (match the floor both siblings ship; presigned uploads are load-bearing for Studio).
- `install`:
  - `alias: "studio"`, `deployment: { path: "dist", basePath: "/apps/studio/dist" }` (sibling pattern), `domain: { subdomain: "studio", isPublic: false, isSpa: true }` — **`isPublic: false` is load-bearing**: Studio's rules intentionally carry no per-rule auth validators, so the private domain is what gates the paid AI endpoints. The reference deploy further sets `requiredRole: admin`, which the manifest cannot express (same gap reader hit) → covered by a manual step (§5).
  - `ruleSets`: **both** sets — `rulesets/studio.json`, `rulesets/studio-blog.json`, each `attachToAlias: true`.
  - `schedules: []`.
  - `manualSteps`: §5.
- `eject`: `{ repo: "bffless/apps", appPath: "apps/studio", deployWorkflow: "deploy-studio.yml", variables: ["BFFLESS_URL", "BFFLESS_PROJECT"], secrets: ["BFFLESS_API_KEY"] }`.

### 4.2 Catalog assets (`apps/studio/catalog/`)

`description.md`, `icon.png` (256²), `thumbnail.png` (1200×630), `screenshots/` (4 × 1440×900) — shot **after** the restyle lands, using the mock-driven Playwright recipe established for reader (fixtures through MSW/route interception; no real footage or credentials).

### 4.3 Versioning & registry wiring (required by `pnpm apps:check`)

- `release-please-config.json`: `packages["apps/studio"]` entry with `component`, `include-component-in-tag: true`, `extra-files` json-path to `bffless-app.json` `$.version`.
- `.release-please-manifest.json`: seed `"apps/studio": "1.0.0"` — release-please owns the version thereafter; PR title is the release signal (squash merges).
- `apps/studio/package.json` version 0.0.0 → 1.0.0; seed `CHANGELOG.md`.
- Publish after merge via the release flow (`release.yml` → bundles → publish-registry to the `app-registry` alias on admin.bffless.dev). No hand-runs of registry publishing.

### 4.4 Known gap to resolve: the AI-skills artifact

`deploy-studio.yml` uploads `apps/studio/.bffless/skills` as a **second** artifact (`base-path: .bffless/skills`) — the `image-prompts` skill consumed by the `/api/thumbnail/draft` ai_handler. The catalog bundle ships only `bffless-app.json` + rulesets + `dist/**`, so a 1-click install would miss those files and thumbnail drafting would break.

Resolution direction: make the built artifact self-contained — copy `.bffless/skills/**` into `dist/.bffless/skills/` at build time (Vite `publicDir`-adjacent copy step) so both the CI deploy and the catalog bundle carry it, and simplify `deploy-studio.yml` to a single upload. Must verify the ai_handler resolves the skill at the deployment-relative path in an installed context before removing the second upload. If it can't be made deployment-relative, fall back to keeping the second upload for CI and adding an install manualStep — decided by testing during implementation.

## 5. Required secrets → `install.manualSteps`

The manifest schema has no first-class secrets field; `manualSteps` is the mechanism. Each step ≤220 chars (repo CI enforces), imperative title, deep-linked, `appliesWhen: "always"` (default). Full detail stays in `apps/studio/bffless/README.md` ("Manual setup (admin panel)" + "Prerequisites" sections — already present and CI-checked).

| id | title | body (gist) | deepLink |
|---|---|---|---|
| `connect-replicate` | Connect Replicate | Add a Replicate API token under Settings → AI Services. Powers transcription (WhisperX), scene direction (Gemini), voice clone/speech (MiniMax — voice clone ≈ $3/call), thumbnails. | settings AI tab |
| `connect-anthropic` | Connect Anthropic | Add an Anthropic API key under Settings → AI Services. Powers thumbnail drafts and the blog writer. | settings AI tab |
| `add-hf-token` | Add HF_TOKEN secret | Create secret `HF_TOKEN` (Hugging Face read token) under Settings → Secrets — required by WhisperX alignment/diarization on transcribe. | settings secrets tab |
| `coop-coep-headers` | Add COOP/COEP response headers | Add a response-header rule on `**`: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless` — required for ffmpeg.wasm export. The installer cannot create header rules. | response-headers page |
| `restrict-access` | Keep Studio private | Studio's API rules have no per-rule auth — the private domain is what protects the paid AI endpoints. Keep the domain non-public; optionally raise its required role to admin. | `/repo/{projectPath}/settings?tab=members` |

deepLink shape follows reader's pattern (`/repo/{projectPath}/settings?tab=members`); exact tab slugs for AI Services / Secrets / response headers verified against CE's admin routes at implementation time (closed placeholder set: `{projectPath}`, `{appHost}` only).

## 6. Delivery

Two PRs, both branched via worktrees off current `origin/main`:

- **PR A — restyle**: §2 + §3 (+ `PRODUCT.md`, `DESIGN.md`). Validation: `pnpm --filter studio build && lint && test:run`, plus headless screenshots of Import/Prep/Build/Export and the projects list; contrast spot-checks.
- **PR B — catalog publish**: §4 + §5 (manifest, catalog assets, release-please wiring, skills-artifact fix). Depends on PR A for screenshots. Validation: `pnpm apps:check`, `node scripts/build-app-bundle.mjs studio` + bundle-layout inspection, registry build test.

Merging either only redeploys Studio's frontend/rules as usual (no registry effect until the release flow runs). All commits/pushes/PRs and the eventual release tag get explicit user approval first.
