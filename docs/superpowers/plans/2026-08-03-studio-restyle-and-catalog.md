# Studio Restyle + App-Catalog Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin Studio (`apps/studio`) from the taupe/terracotta landing-site look to its own violet-on-neutral identity, then publish it to the CE app catalog with required secrets documented as install manual steps.

**Architecture:** Phase A is a token-layer re-skin: rewrite the `@theme` block in `src/index.css` with honest semantic names (surface/line/ink/accent), then a mechanical class-name sweep across ~40 components plus targeted cleanups (wordmark, stepper, stage cards, corner-marks removal). Phase B adds the catalog manifest + assets + release-please wiring, and makes the install bundle self-contained (AI skills folded into `dist/`).

**Tech Stack:** Tailwind v4 CSS-first (`@theme`, no config file, **no preflight**), React 19 + Vite, Vitest, release-please, `scripts/build-app-bundle.mjs` / `check-app-conventions.mjs` tooling.

**Spec:** `docs/superpowers/specs/2026-08-03-studio-restyle-and-catalog-design.md` (approved 2026-08-03). Strategic context: `apps/studio/PRODUCT.md`.

## Global Constraints

- Repo root is `/home/rico/bffless/repos/apps`. All `pnpm` commands run from there. Work on a fresh branch per phase, created via worktree off `origin/main` (`superpowers:using-git-worktrees`); the shared checkout may sit on another branch.
- **Workspace rule: ask the user before every commit, push, or PR creation.** The commit steps below mark *where* commits happen; each first-commit/push/PR of a phase needs explicit user approval.
- Phase A = PR "Studio restyle" (branch `studio-restyle`). Phase B = PR "Studio catalog publish" (branch `studio-catalog`, created after PR A merges — its screenshots need Phase A's look).
- Keep the existing CSS import structure (`theme.css` + `utilities.css`, hand-written `box-sizing` reset). Do NOT add Tailwind preflight.
- No structural UX changes: no route, state, or component-hierarchy edits.
- WCAG AA: text tokens ≥4.5:1 on their surfaces (`ink-mute` targets ≥7:1); `ink-faint` never used for body text; white-on-accent only at button size/weight.
- Token names are final (spec §2.1): `surface`, `surface-raised`, `surface-dim`, `line`, `ink`, `ink-soft`, `ink-mute`, `ink-faint`, `accent`, `accent-hover`, `accent-ink`, `voice`, `voice-ink`.
- `pnpm --filter studio build && pnpm --filter studio lint && pnpm --filter studio test:run` must pass at the end of every task that touches `apps/studio`.
- Phase B: manualStep `body` ≤ 220 chars (CI-enforced by `scripts/check-app-conventions.mjs`); deepLink placeholders limited to `{projectPath}` / `{appHost}`; `bffless-app.json` `version` is release-please-owned after seeding — never hand-edit later.
- Never rename the `registry-staging` output dir or touch `.github/workflows/release.yml`'s registry publishing.

---

## Phase A — Restyle (PR `studio-restyle`)

### Task A1: New token system in `index.css` + font trim in `index.html`

**Files:**
- Modify: `apps/studio/src/index.css` (full rewrite below)
- Modify: `apps/studio/index.html` (fonts link + description)

**Interfaces:**
- Produces: CSS custom properties `--color-surface`, `--color-surface-raised`, `--color-surface-dim`, `--color-line`, `--color-ink`, `--color-ink-soft`, `--color-ink-mute`, `--color-ink-faint`, `--color-accent`, `--color-accent-hover`, `--color-accent-ink`, `--color-voice`, `--color-voice-ink`; utility classes `bg-surface`, `text-ink`, `border-line`, `bg-accent`, etc.; component classes `.container-page`, `.rule`, `.meta-label`, `.pill-cta`, `.pill-ghost` (names unchanged, restyled). `.corner-marks` is REMOVED. Every later task relies on these exact token names.

- [ ] **Step 1: Replace the entire contents of `apps/studio/src/index.css` with:**

```css
@layer theme, base, components, utilities;
@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/utilities.css' layer(utilities);

@theme {
  /* Neutral surfaces with a whisper of violet (chroma .003–.006 at hue ~300) */
  --color-surface: oklch(0.985 0.003 300);
  --color-surface-raised: oklch(1 0 0);
  --color-surface-dim: oklch(0.962 0.004 300);
  --color-line: oklch(0.9 0.006 300);

  /* Ink text scale — AA-checked on surface; ink-faint is decorative/disabled ONLY */
  --color-ink: oklch(0.21 0.012 300);
  --color-ink-soft: oklch(0.35 0.012 300);
  --color-ink-mute: oklch(0.45 0.015 300);
  --color-ink-faint: oklch(0.72 0.015 300);

  /* Violet accent — actions, selection, active state; never decoration */
  --color-accent: oklch(0.541 0.281 293.009);
  --color-accent-hover: oklch(0.491 0.27 292.581);
  --color-accent-ink: oklch(0.283 0.141 291.089);

  /* Emerald "voiced" span highlight in the diff viewer (role unchanged) */
  --color-voice: oklch(0.508 0.118 165.612);
  --color-voice-ink: oklch(0.378 0.077 168.94);

  --font-sans:
    'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
    sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;

  --animate-slide-up: slide-up 0.3s ease-out;
  --animate-in: anim-in 0.2s ease-out;

  @keyframes slide-up {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes anim-in {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
}

@layer base {
  /* We don't pull in Tailwind's preflight, so its global box-sizing reset is
     missing. Without it any `w-full` element with padding/border overflows its
     container by that padding+border (the rename input, the director textarea).
     border-box is what every Tailwind utility already assumes. */
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  :root {
    color-scheme: light;
  }

  html {
    scroll-behavior: smooth;
  }

  body {
    margin: 0;
    background-color: var(--color-surface);
    color: var(--color-ink);
    font-family: var(--font-sans);
    font-size: 16px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }

  ::selection {
    background-color: var(--color-accent);
    color: #fff;
  }

  h1,
  h2,
  h3 {
    font-family: var(--font-sans);
    font-weight: 600;
    letter-spacing: -0.015em;
    text-wrap: balance;
    color: var(--color-ink);
    margin: 0;
  }

  a {
    color: inherit;
  }

  /* Timecodes and other mono runs must not jitter while values change. */
  :where(.font-mono) {
    font-variant-numeric: tabular-nums;
  }

  /* Visible focus for every interactive element (WCAG AA). */
  :where(button, a, input, select, textarea, [tabindex]):focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    html {
      scroll-behavior: auto;
    }
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
}

@layer components {
  .container-page {
    width: 100%;
    max-width: 1280px;
    margin-inline: auto;
    padding-inline: 1.5rem;
  }

  .rule {
    border-color: var(--color-line);
  }

  .meta-label {
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-ink-mute);
  }

  .pill-cta,
  .pill-ghost {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem;
    border-radius: 6px;
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 0.875rem;
    letter-spacing: 0.01em;
    text-decoration: none;
    cursor: pointer;
    transition:
      background-color 150ms ease,
      color 150ms ease,
      border-color 150ms ease;
  }

  .pill-cta {
    background-color: var(--color-accent);
    color: #fff;
    border: 1px solid var(--color-accent);
  }
  .pill-cta:hover {
    background-color: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
  }

  .pill-ghost {
    background-color: transparent;
    color: var(--color-ink);
    border: 1px solid var(--color-line);
  }
  .pill-ghost:hover {
    background-color: var(--color-surface-dim);
  }

  .pill-cta:disabled,
  .pill-ghost:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
```

Deliberate deltas vs the old file: dot-grid `background-image` gone; `--font-serif` gone; `.corner-marks` gone; base font 17px → 16px; pills 999px → 6px radius; ghost hover is a dim fill (not full-ink inversion); `.meta-label` 10px/0.18em → 11px/0.08em; new focus-visible, tabular-nums, and reduced-motion blocks.

- [ ] **Step 2: In `apps/studio/index.html`**, replace the Google Fonts `href` (drop Fraunces, keep Inter + JetBrains Mono):

```html
    <link
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
      rel="stylesheet"
    />
```

Also replace the stale `<meta name="description">` (it still describes the demo playground):

```html
    <meta
      name="description"
      content="Studio — cut a long screen recording into a short video in your own voice. AI proposes the scenes and cuts; you tune them; nothing is re-voiced."
    />
```

- [ ] **Step 3: Build to verify the CSS parses** (components still reference old tokens — unknown utilities like `bg-paper` don't fail Tailwind v4 builds, they just emit nothing; the sweep in A2 fixes them):

Run: `pnpm --filter studio build`
Expected: PASS (type-check + vite build)

- [ ] **Step 4: Commit** (with user approval, per Global Constraints)

```bash
git add apps/studio/src/index.css apps/studio/index.html
git commit -m "feat(studio): new token system — violet accent on neutral surfaces"
```

### Task A2: Mechanical token sweep across components

**Files:**
- Modify: every file under `apps/studio/src/` matching the old token names (~40 `.tsx`, plus comments in `.ts`)

**Interfaces:**
- Consumes: token utilities from Task A1.
- Produces: zero occurrences of `paper`, `terracotta`, or `font-serif` under `apps/studio/src/`.

- [ ] **Step 1: Run the ordered replacements** (longest names first so `paper-line` never half-matches as `paper`):

```bash
cd apps/studio
grep -rl -e paper -e terracotta -e font-serif src --include='*.tsx' --include='*.ts' | xargs sed -i \
  -e 's/paper-line/line/g' \
  -e 's/paper-deep/surface-dim/g' \
  -e 's/paper/surface/g' \
  -e 's/terracotta-hover/accent-hover/g' \
  -e 's/terracotta-ink/accent-ink/g' \
  -e 's/terracotta/accent/g' \
  -e 's/font-serif/font-semibold tracking-[-0.01em]/g'
cd ../..
```

Notes for the reviewer: this intentionally rewrites prose comments too ("terracotta fill = done" → "accent fill = done"), which keeps comments truthful. `text-paper` (light text on accent fills) becomes `text-surface`, which is near-white on accent: correct. A few spots gain a duplicate `font-semibold` (e.g. `StudioStepper`'s current-label branch); harmless, and A4 cleans the ones it touches.

- [ ] **Step 2: Verify nothing is left**

Run: `grep -rn -e paper -e terracotta -e 'font-serif' apps/studio/src && echo LEFTOVERS || echo CLEAN`
Expected: `CLEAN`

- [ ] **Step 3: Build, lint, test**

Run: `pnpm --filter studio build && pnpm --filter studio lint && pnpm --filter studio test:run`
Expected: all PASS. If lint flags the `tracking-[-0.01em]` insertion producing a doubled class in some file, dedupe that className by hand.

- [ ] **Step 4: Commit** (with user approval)

```bash
git add -A apps/studio/src
git commit -m "feat(studio): sweep components onto the new token names"
```

### Task A3: App shell wordmark

**Files:**
- Modify: `apps/studio/src/App.tsx:23-28`

**Interfaces:**
- Consumes: `bg-accent`, `bg-surface/85`, `.rule` from A1 (A2 already renamed this file's `bg-paper/85` → `bg-surface/85`).

- [ ] **Step 1: Replace the header block.** After A2 the header reads `bg-surface/85` and the link has `font-semibold tracking-[-0.01em] text-lg font-semibold text-ink`. Replace the `<header>…</header>` element with:

```tsx
      <header className="sticky top-0 z-40 border-b rule bg-surface/85 backdrop-blur">
        <div className="container-page flex h-14 items-center">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold tracking-[-0.01em] text-ink">
            <span
              aria-hidden="true"
              className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-accent"
            >
              <span className="ml-0.5 h-0 w-0 border-y-[5px] border-l-[8px] border-y-transparent border-l-white" />
            </span>
            Studio
          </Link>
        </div>
      </header>
```

(The tile is a small accent square with a white play glyph, matching the approved prototype page.)

- [ ] **Step 2: Visual + automated check**

Run: `pnpm --filter studio build && pnpm --filter studio lint`
Expected: PASS

- [ ] **Step 3: Commit** (with user approval)

```bash
git add apps/studio/src/App.tsx
git commit -m "feat(studio): wordmark with accent play tile in the app shell"
```

### Task A4: StageCard — replace the side-stripe active treatment

**Files:**
- Modify: `apps/studio/src/components/Studio/StageCard.tsx`

**Interfaces:**
- Consumes: `border-accent`, `bg-surface-raised`, `rounded-lg` (A1). Component props unchanged.

- [ ] **Step 1: Replace the outer `<div>` className computation** (lines ~23-33 post-sweep; the sweep left `border-l-2` + accent colors). New version — full border card, `rounded-lg`, raised surface:

```tsx
    <div
      className={[
        'flex items-start gap-4 rounded-lg border bg-surface-raised px-5 py-4 transition-colors',
        active
          ? 'border-accent'
          : error
            ? 'border-accent-ink'
            : done
              ? 'border-line opacity-60'
              : 'border-line',
      ].join(' ')}
    >
```

- [ ] **Step 2: Dedupe the `<h4>` classes** the sweep produced (`font-semibold tracking-[-0.01em] text-[17px] leading-tight text-ink` is correct; if the file shows a doubled `font-semibold`, remove one).

- [ ] **Step 3: Build + eyeball**

Run: `pnpm --filter studio build && pnpm --filter studio lint && pnpm --filter studio test:run`
Expected: PASS

- [ ] **Step 4: Commit** (with user approval)

```bash
git add apps/studio/src/components/Studio/StageCard.tsx
git commit -m "feat(studio): stage cards use full accent border, not a side stripe"
```

### Task A5: Corner-marks removal + Section/Dot comment truth

**Files:**
- Modify: `apps/studio/src/components/Studio/MediaImport.tsx` (drop the `corner-marks` class usage)
- Modify: `apps/studio/src/components/Section.tsx` (comment only)

- [ ] **Step 1:** In `MediaImport.tsx`, find the element whose `className` contains `corner-marks` and delete just that class token from the string (keep the rest of the classes and the element). The CSS class no longer exists after A1; leaving the dead class invites confusion.

- [ ] **Step 2:** In `Section.tsx`, A2 turned `<Dot/>` into `text-accent` but its doc comment still says "terracotta period — the landing site's signature punctuation accent". Replace the comment:

```tsx
/** An accent-colored period used in page titles. */
export function Dot() {
  return <span className="text-accent">.</span>
}
```

- [ ] **Step 3: Verify + commit** (with user approval)

Run: `grep -rn "corner-marks" apps/studio/src && echo LEFTOVER || echo CLEAN` → `CLEAN`, then `pnpm --filter studio build && pnpm --filter studio lint`

```bash
git add apps/studio/src/components/Studio/MediaImport.tsx apps/studio/src/components/Section.tsx
git commit -m "chore(studio): drop corner-marks decoration; fix Dot comment"
```

### Task A6: Headless visual validation pass

**Files:**
- Create (scratchpad only, not committed): screenshots via `localdev-tools/shot.mjs`

- [ ] **Step 1: Start the dev server in the background**

Run (from repo root): `pnpm --filter studio dev -- --port 5179` (background)

- [ ] **Step 2: Screenshot the projects page**

Run: `cd /home/rico/bffless/localdev-tools && node shot.mjs http://localhost:5179/ --out <scratchpad>/studio-restyle-home.png --full`
Expected: exit 0 (`consoleErrors: 0`; a failed `/api/*` request may appear because the headless session is unauthenticated against j5s.dev — that specific failure is expected, not a regression).

- [ ] **Step 3: Review the screenshot** against the approved prototype (https://handoff.bffless.dev/blob/specs/studio-restyle-design): neutral surface (no taupe, no dot grid), violet accent only on actions/state, Inter headings, no serif anywhere, buttons are 6px rectangles. Fix any visual misses (spacing, leftover odd colors) with targeted edits, re-shoot until it reads precise/calm/focused.

- [ ] **Step 4: Contrast spot-check.** Confirm computed colors: body text on `surface`, `ink-mute` labels on `surface-dim`, white on `accent` buttons. The OKLCH values in A1 were pre-checked (ink 15.9:1, ink-soft 9.6:1, ink-mute 7.1:1, white-on-accent 5.5:1); if any component pairs `ink-faint` with body copy, upgrade it to `ink-mute`.

- [ ] **Step 5: Stop the dev server; commit any fix-ups** (with user approval)

```bash
git add -A apps/studio/src
git commit -m "polish(studio): visual pass fix-ups from headless screenshots"
```

### Task A7: DESIGN.md + include spec/PRODUCT.md in the PR

**Files:**
- Create: `apps/studio/DESIGN.md`
- Already created (commit them here): `apps/studio/PRODUCT.md`, `docs/superpowers/specs/2026-08-03-studio-restyle-and-catalog-design.md`, this plan file

- [ ] **Step 1: Write `apps/studio/DESIGN.md`:**

```markdown
# Studio — visual system

Register: product (see PRODUCT.md). Personality: precise, calm, focused.
Strategy: restrained — neutral chrome, one accent for actions/selection/state.
"The footage is the color."

## Tokens (`src/index.css` `@theme`, OKLCH)

| Token | Value | Role |
|---|---|---|
| `surface` | `oklch(0.985 0.003 300)` | page background |
| `surface-raised` | `oklch(1 0 0)` | cards, panels, inputs |
| `surface-dim` | `oklch(0.962 0.004 300)` | wells, toolbars |
| `line` | `oklch(0.9 0.006 300)` | hairlines, borders |
| `ink` | `oklch(0.21 0.012 300)` | primary text (15.9:1) |
| `ink-soft` | `oklch(0.35 0.012 300)` | secondary text (9.6:1) |
| `ink-mute` | `oklch(0.45 0.015 300)` | tertiary text (7.1:1, AA floor) |
| `ink-faint` | `oklch(0.72 0.015 300)` | disabled/decorative ONLY — never body text |
| `accent` | `oklch(0.541 0.281 293.009)` (violet-600) | primary actions, selection, active |
| `accent-hover` | `oklch(0.491 0.27 292.581)` | hover |
| `accent-ink` | `oklch(0.283 0.141 291.089)` | accent-colored text on light tints |
| `voice` | `oklch(0.508 0.118 165.612)` | voiced spans in the diff viewer |
| `voice-ink` | `oklch(0.378 0.077 168.94)` | voiced-span emphasis |

Neutrals carry a whisper of violet (hue ~300) so chrome relates to the accent.
Dark mode is deferred by design: tokens are CSS variables, so it lands later as
a var flip + contrast tuning.

## Typography

- Inter everywhere; headings are `font-semibold tracking-[-0.01em]`, `text-wrap: balance`.
- JetBrains Mono ONLY where mono is functional: timecodes, durations, cut
  ranges, `.meta-label`. `.font-mono` gets `tabular-nums` globally.
- Base 16px / 1.5. Fixed rem scale (~1.125 ratio); no fluid clamp headings.

## Components

- Controls `rounded-md` (6px); cards `rounded-lg` (8px) on `surface-raised`.
- `.pill-cta` accent fill / white text; `.pill-ghost` `line` border, `surface-dim` hover fill.
- Active state = full `border-accent` (side-stripe accents are banned).
- `.meta-label`: 11px mono uppercase, 0.08em tracking, `ink-mute`.
- Focus: global `:focus-visible` 2px accent outline. Motion 150–300ms ease-out,
  with a `prefers-reduced-motion` collapse.

## Accessibility

WCAG AA. Body text ≥4.5:1; visible focus everywhere; color never the sole
state carrier (steppers/cards pair color with glyphs and labels).
```

- [ ] **Step 2: Commit docs, push branch, open PR A** (each with user approval)

```bash
git add apps/studio/DESIGN.md apps/studio/PRODUCT.md docs/superpowers/specs/2026-08-03-studio-restyle-and-catalog-design.md docs/superpowers/plans/2026-08-03-studio-restyle-and-catalog.md
git commit -m "docs(studio): PRODUCT.md, DESIGN.md, restyle spec + plan"
```

PR title: `feat(studio): own visual identity — violet accent on neutral surfaces` (PR titles are the release signal in this repo; `feat` scope only, no release-please impact until Phase B seeds the package). Push all commits BEFORE opening the PR (user merges fast). PR body: link the spec, the prototype page (https://handoff.bffless.dev/blob/specs/studio-restyle-design), and the before/after screenshots.

---

## Phase B — Catalog publish (PR `studio-catalog`, branch off `origin/main` AFTER PR A merges)

### Task B1: Make the install bundle self-contained (AI skills into `dist/`)

**Files:**
- Investigate first: CE skill resolution in `repos/ce` (see Step 1)
- Modify: `apps/studio/package.json` (build script)
- Modify: `.github/workflows/deploy-studio.yml` (only if Step 1 proves it safe)

**Interfaces:**
- Produces: `apps/studio/dist/.bffless/skills/**` present after `pnpm --filter studio build`; the catalog bundle therefore carries the `image-prompts` skill the `/api/thumbnail/draft` ai_handler loads.

- [ ] **Step 1: Establish how CE resolves ai_handler skills.** Read the CE source (read via `git show origin/main:<path>` in `/home/rico/bffless/repos/ce` — the checkout may be stale): grep for how `skills.mode: selected` + `enabled: [image-prompts]` finds skill files (`grep -rn "SKILL.md\|load_skill\|skills" apps/backend/src --include="*.ts" -l` then read the resolver). The question to answer: does it look up skill files by scanning the alias's deployment publicPaths for `.bffless/skills/<name>/SKILL.md` (suffix match), or by an exact path prefix? Record the answer in the PR description.
  - If **suffix/deployment-relative match**: folding skills into `dist/` works for both CI deploys and catalog installs → do Steps 2-4 and ALSO delete the now-redundant "Upload AI skills to BFFless" step from `deploy-studio.yml`.
  - If **exact `.bffless/skills/...` prefix required** and a `dist`-prefixed deploy can't satisfy it: still do Steps 2-3 (the bundle needs the files for installs, where the deployment isn't nested under `apps/studio/dist`), keep the CI second upload unchanged, and verify on j5s.dev after merge that thumbnail drafting still works.
  - If neither works for installs: remove the copy, add a sixth manualStep to B2's manifest instead: `{ "id": "upload-ai-skills", "title": "Upload the AI skills bundle", "body": "Thumbnail drafting loads the image-prompts skill from the deployment. Re-deploying via the fork workflow uploads it; without a fork, copy .bffless/skills from the repo into your deployment.", "appliesWhen": "always" }` and note the CE limitation in the PR.

- [ ] **Step 2: Add the copy to the build.** In `apps/studio/package.json`, change the `build` script from `tsc -b && vite build` to:

```json
    "build": "tsc -b && vite build && node scripts/copy-skills.mjs",
```

and create `apps/studio/scripts/copy-skills.mjs`:

```js
// Fold the authored AI skills into dist/ so a single artifact (CI deploy or
// catalog bundle) carries everything the pipelines' ai_handler loads.
import { cpSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, '.bffless', 'skills')
const dest = join(root, 'dist', '.bffless', 'skills')

if (!existsSync(src)) {
  console.error(`copy-skills: missing ${src}`)
  process.exit(1)
}
cpSync(src, dest, { recursive: true })
console.log(`copy-skills: ${src} -> ${dest}`)
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter studio build && ls apps/studio/dist/.bffless/skills/image-prompts/SKILL.md`
Expected: file exists. Then `pnpm --filter studio test:run` still PASSES.

- [ ] **Step 4 (only per Step 1's finding): simplify `deploy-studio.yml`** by deleting the entire final "Upload AI skills to BFFless" step (the `bffless/upload-artifact` block with `path: apps/studio/.bffless/skills`).

- [ ] **Step 5: Commit** (with user approval)

```bash
git add apps/studio/package.json apps/studio/scripts/copy-skills.mjs .github/workflows/deploy-studio.yml
git commit -m "feat(studio): fold AI skills into dist so the install bundle is self-contained"
```

### Task B2: `bffless-app.json` manifest

**Files:**
- Create: `apps/studio/bffless-app.json`

**Interfaces:**
- Consumes: sibling manifests as the schema reference (`apps/reader/bffless-app.json`, `apps/handoff/bffless-app.json`).
- Produces: manifest consumed by B4's release-please wiring (`extra-files` jsonpath `$.version`) and B5's bundle build.

- [ ] **Step 1: Verify the deepLink tab slugs against CE.** Reader uses `/repo/{projectPath}/settings?tab=members`. Find the real tab slugs for AI services, secrets, and response headers in the CE frontend router: `cd /home/rico/bffless/repos/ce && git fetch origin && git grep -n "tab=" origin/main -- apps/frontend/src | grep -i "settings" | head -20` (look for the settings-tab query values; also check the response-headers route path). Substitute the real slugs for `TAB_AI`, `TAB_SECRETS`, and `RESPONSE_HEADERS_PATH` below — these three placeholders are the ONLY values not final in this step.

- [ ] **Step 2: Write `apps/studio/bffless-app.json`:**

```json
{
  "schemaVersion": 1,
  "id": "studio",
  "name": "Studio",
  "version": "1.0.0",
  "summary": "Cut a long screen recording into a short video in your own voice — AI proposes the scenes and cuts, you tune them, nothing is re-voiced.",
  "category": "video",
  "docsUrl": "https://github.com/bffless/apps/blob/main/apps/studio/bffless/README.md",
  "sourceUrl": "https://github.com/bffless/apps/tree/main/apps/studio",
  "requires": {
    "presignedStorage": true,
    "ceMin": "0.4.13"
  },
  "install": {
    "alias": "studio",
    "deployment": {
      "path": "dist",
      "basePath": "/apps/studio/dist"
    },
    "ruleSets": [
      {
        "file": "rulesets/studio.json",
        "attachToAlias": true
      },
      {
        "file": "rulesets/studio-blog.json",
        "attachToAlias": true
      }
    ],
    "domain": {
      "subdomain": "studio",
      "isPublic": false,
      "isSpa": true
    },
    "schedules": [],
    "manualSteps": [
      {
        "id": "connect-replicate",
        "title": "Connect Replicate",
        "body": "Add a Replicate API token under Settings → AI Services. It powers transcription (WhisperX), scene direction (Gemini), voice clone/speech (MiniMax — clone ≈ $3/call), and thumbnails.",
        "deepLink": "/repo/{projectPath}/settings?tab=TAB_AI",
        "appliesWhen": "always"
      },
      {
        "id": "connect-anthropic",
        "title": "Connect Anthropic",
        "body": "Add an Anthropic API key under Settings → AI Services. It powers thumbnail prompt drafts and the companion blog writer.",
        "deepLink": "/repo/{projectPath}/settings?tab=TAB_AI",
        "appliesWhen": "always"
      },
      {
        "id": "add-hf-token",
        "title": "Add the HF_TOKEN secret",
        "body": "Create a secret named HF_TOKEN with a Hugging Face read token under Settings → Secrets. Transcription's WhisperX alignment/diarization requires it.",
        "deepLink": "/repo/{projectPath}/settings?tab=TAB_SECRETS",
        "appliesWhen": "always"
      },
      {
        "id": "coop-coep-headers",
        "title": "Add COOP/COEP response headers",
        "body": "Add a response-header rule on ** setting Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless. Video export (ffmpeg.wasm) needs them; the installer can't create header rules.",
        "deepLink": "RESPONSE_HEADERS_PATH",
        "appliesWhen": "always"
      },
      {
        "id": "restrict-access",
        "title": "Keep Studio private",
        "body": "Studio's API rules carry no per-rule auth — the private domain is what protects the paid AI endpoints. Keep the domain non-public; optionally require the admin role.",
        "deepLink": "/repo/{projectPath}/settings?tab=members",
        "appliesWhen": "always"
      }
    ]
  },
  "eject": {
    "repo": "bffless/apps",
    "appPath": "apps/studio",
    "deployWorkflow": "deploy-studio.yml",
    "variables": ["BFFLESS_URL", "BFFLESS_PROJECT"],
    "secrets": ["BFFLESS_API_KEY"]
  }
}
```

If B1 landed the sixth `upload-ai-skills` manualStep (fallback branch only), append it here.

- [ ] **Step 3: Length-check every manualStep body** (each must be ≤220 chars):

Run: `node -e "for (const s of require('./apps/studio/bffless-app.json').install.manualSteps) console.log(s.body.length, s.id)"`
Expected: every count ≤ 220. Trim wording if any exceeds.

- [ ] **Step 4: Commit** (with user approval)

```bash
git add apps/studio/bffless-app.json
git commit -m "feat(studio): app-catalog manifest with secrets documented as manual steps"
```

### Task B3: Catalog assets (description, icon, thumbnail, screenshots)

**Files:**
- Create: `apps/studio/catalog/description.md`
- Create: `apps/studio/catalog/icon.png` (256×256)
- Create: `apps/studio/catalog/thumbnail.png` (1200×630)
- Create: `apps/studio/catalog/screenshots/01-projects.png`, `02-prep.png`, `03-cut-editor.png`, `04-export.png` (1440×900)
- Create (scratchpad, not committed): a Playwright capture script

- [ ] **Step 1: Write `apps/studio/catalog/description.md`:**

```markdown
Studio turns one long, rambly screen recording into a short, watchable video —
in your own recorded voice. Nothing is re-voiced and the AI never rewrites what
you said.

**How it works**

1. **Import** a screen recording. It uploads straight to your storage bucket
   (presigned, so big files are fine).
2. **Prep** runs the locked pipeline: audio extraction, word-level
   transcription (WhisperX), a contact sheet of frames, and the AI "master
   director" that splits the recording into scenes and proposes cuts.
3. **Build** is where you produce: tune each scene's cuts on the transcript
   grid, optionally run the per-scene refiner, and assemble kept spans with the
   clip's own audio.
4. **Export** stitches the final cut entirely in your browser with ffmpeg.wasm
   — no render farm, nothing leaves your machine.

There's also a companion blog writer that drafts a post (with pulled stills)
from the finished video's transcript, and an AI thumbnail workflow.

**What it needs**

Studio is a static app; every backend step is a BFFless pipeline on your own
instance. Bring a Replicate token (transcription, scene direction, voice,
thumbnails), an Anthropic key (thumbnail drafts, blog writer), a Hugging Face
`HF_TOKEN` secret, a storage bucket with presigned uploads, and one COOP/COEP
response-header rule for the in-browser exporter. The install steps walk
through each.
```

- [ ] **Step 2: Capture screenshots.** Follow the reader recipe (memory: mock-driven, no auth). Run the dev server (`pnpm --filter studio dev -- --port 5199`), then a Playwright script run from `repos/apps` (it has `@playwright/test` above it; scratchpad does not). Script skeleton — the executor iterates on fixtures until the four shots look real and uncluttered:

```js
// scratchpad/studio-shots.mjs — run: node scratchpad/studio-shots.mjs (from repos/apps)
import { chromium } from '@playwright/test'

const BASE = 'http://localhost:5199'
const OUT = 'apps/studio/catalog/screenshots'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

// Block real backend + asset hosts; answer with fixtures so no auth is needed.
await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))

// Seed redux-persist state with a fictional project (titles/transcripts invented,
// nothing real). Shape must match src/store/studioSlice.ts — copy a real
// localStorage['persist:studio'] value from a manual dev session as the template,
// then swap in fictional content.
await page.addInitScript((state) => {
  window.localStorage.setItem('persist:studio', state)
}, JSON.stringify(FIXTURE /* built per above */))

await page.goto(BASE + '/')
await page.screenshot({ path: `${OUT}/01-projects.png` })
// …navigate to /project/<fixture-id>/prep, /build, /export and shoot 02–04…
await browser.close()
```

Acceptance criteria per shot: 1440×900; the new violet/neutral look; believable fictional content (no real names/footage); no error toasts or empty voids. `02-prep` shows the stage board mid-pipeline; `03-cut-editor` shows the transcript grid with voiced/cut spans; `04-export` shows the export summary. Contact-sheet/filmstrip images: intercept their URLs with a generated placeholder PNG (solid `surface-dim` frames), same trick reader used for hero images.

- [ ] **Step 3: Icon + thumbnail.** Icon: 256×256 PNG of the accent play-tile on `surface` (render `<span class="tile">` from the prototype page at size via a tiny HTML file + Playwright screenshot, or draw with node-canvas). Thumbnail: 1200×630 crop of the best-looking Build screen (reader precedent: a product-surface crop, not marketing art).

- [ ] **Step 4: Verify + commit** (with user approval)

Run: `file apps/studio/catalog/*.png apps/studio/catalog/screenshots/*.png` → confirm dimensions.

```bash
git add apps/studio/catalog
git commit -m "feat(studio): catalog assets — description, icon, thumbnail, screenshots"
```

### Task B4: Versioning + release-please wiring

**Files:**
- Modify: `release-please-config.json`
- Modify: `.release-please-manifest.json`
- Modify: `apps/studio/package.json` (version only)
- Create: `apps/studio/CHANGELOG.md`

- [ ] **Step 1:** Add to `release-please-config.json` `packages` (exact sibling shape):

```json
    "apps/studio": {
      "release-type": "node",
      "component": "studio",
      "include-component-in-tag": true,
      "extra-files": [
        {
          "type": "json",
          "path": "bffless-app.json",
          "jsonpath": "$.version"
        }
      ]
    }
```

- [ ] **Step 2:** Add to `.release-please-manifest.json`:

```json
  "apps/studio": "1.0.0"
```

- [ ] **Step 3:** In `apps/studio/package.json`, change `"version": "0.0.0"` → `"version": "1.0.0"` and remove `"private": true` **only if** reader/handoff aren't private either (check: `node -e "console.log(require('./apps/reader/package.json').private, require('./apps/handoff/package.json').private)"` — mirror whatever they do).

- [ ] **Step 4:** Create `apps/studio/CHANGELOG.md`:

```markdown
# Changelog
```

(release-please appends releases; seed it empty like the siblings — verify with `head -5 apps/reader/CHANGELOG.md` and mirror.)

- [ ] **Step 5: Commit** (with user approval)

```bash
git add release-please-config.json .release-please-manifest.json apps/studio/package.json apps/studio/CHANGELOG.md
git commit -m "chore(studio): seed v1.0.0 release-please wiring"
```

### Task B5: Convention gate + bundle verification, then PR B

- [ ] **Step 1: Run the convention checker**

Run: `pnpm apps:check`
Expected: PASS. It enforces catalog/description.md + thumbnail.png presence, manualStep body length, release-please entries, and the README's required sections ("Manual setup (admin panel)", "First-success checkpoint" — Studio's `bffless/README.md` already has both).

- [ ] **Step 2: Build the bundle and inspect its layout**

Run: `node scripts/build-app-bundle.mjs studio && unzip -l dist-bundles/studio-v1.0.0.bundle.zip | head -40`
Expected: zip contains `bffless-app.json`, `.bffless-build.json` (absent on a dirty tree — expected locally; CI stamps it), `rulesets/studio.json`, `rulesets/studio-blog.json`, and `dist/**` **including `dist/.bffless/skills/image-prompts/SKILL.md`** (from B1).

- [ ] **Step 3: Registry build test**

Run: `node --test scripts/build-registry.test.mjs`
Expected: PASS (confirms the registry builder still handles all manifests, now including studio's).

- [ ] **Step 4: README sync check.** Confirm `apps/studio/bffless/README.md`'s "Manual setup (admin panel)" section lists the same five items as the manifest's manualSteps (Replicate, Anthropic, HF_TOKEN, COOP/COEP, private-domain note). Add the private-domain note if the README lacks it — one sentence under Manual setup:

```markdown
- **Keep the domain private** — Studio's rules carry no per-rule auth; the
  non-public domain (optionally `requiredRole: admin`) is what gates the paid
  AI endpoints.
```

- [ ] **Step 5: Full test sweep, push, PR** (each with user approval)

Run: `pnpm --filter studio build && pnpm --filter studio lint && pnpm --filter studio test:run && pnpm apps:check`

```bash
git add apps/studio/bffless/README.md
git commit -m "docs(studio): align README manual setup with catalog manual steps"
```

PR title: **`feat: add Studio to the app catalog`** — ⚠️ in this repo the squash-merge PR title is the release-please signal; this title cuts `studio-v1.0.0` on merge via the release PR flow. PR body: note the B1 finding about skill resolution, the isPublic:false rationale, and that registry publish happens only through `release.yml` after the release PR merges (no manual `app-bundles.yml` run needed).

### Task B6: Post-merge release + install smoke (coordination, not code)

- [ ] **Step 1:** After PR B merges, release-please opens a release PR for `studio 1.0.0`; merging it (user's call) tags `studio-v1.0.0`, builds the bundle, and publishes the updated `registry.json` to apps.bffless.dev.
- [ ] **Step 2:** Verify `curl -s https://apps.bffless.dev/registry.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d).apps??JSON.parse(d);console.log(JSON.stringify(a.find?a.find(x=>x.id==='studio'):a,null,2))})"` shows studio v1.0.0 with description/thumbnail/screenshots.
- [ ] **Step 3:** 1-click install on a test instance (user has droplets): confirm the five manual steps render, rule sets attach, and — after completing the manual steps — the first-success checkpoint (upload a short recording → see the transcript) passes, plus thumbnail drafting (validates B1's skill decision).

---

## Self-review (done at write time)

- **Spec coverage:** §2 tokens/typography/surfaces → A1; §2.4 contrast → A1 values + A6 step 4; §3 sweep/header/stepper/stage-card/corner-marks → A2-A5; §3 screenshots → A6; DESIGN.md → A7; §4.1 manifest → B2; §4.2 assets → B3; §4.3 wiring → B4; §4.4 skills gap → B1; §5 manual steps → B2; §6 delivery/validation → A6, B5, PR steps.
- **Placeholder scan:** three deliberately-marked lookups remain (`TAB_AI`, `TAB_SECRETS`, `RESPONSE_HEADERS_PATH` in B2), each with an exact command to resolve them in B2 Step 1 — they are verification steps, not TBDs. B3's fixture is bounded by explicit acceptance criteria.
- **Type consistency:** token names match A1 ↔ A2 ↔ A7(DESIGN.md) ↔ prototype page; manifest field shapes copied from live sibling manifests; release-please entry mirrors `apps/reader` exactly.
