# Design

> Visual system for Handoff. Implemented as Tailwind v4 `@theme` tokens in `src/index.css`
> (ADR-0003). Color strategy: **Restrained+** — tuned neutrals + one signature accent (BFFless terracotta)
> + one secondary hue reserved for [[Site]]s + standard state colors. Bold *identity*, calm *surface*.

## Theme

Light + dark, class strategy (`.dark` on `<html>`). Default follows `prefers-color-scheme`; a header
toggle overrides and persists in `localStorage` (`handoff-theme`). Neutrals are tinted ~0.006 chroma
toward the accent hue (285) — cool, not warm-by-default. No cream/sand body bg.

## Color (OKLCH)

### Accent — BFFless terracotta/coral (≈ #D85A3D, hue 40), the signature

Sampled from bffless.app's primary CTA (re-anchored from the original violet — see
the ADR-0003 amendment). Backgrounds/neutrals are unchanged.

| token | light | role |
|---|---|---|
| `--color-accent-50` | `oklch(0.96 0.018 40)` | tint backgrounds |
| `--color-accent-100` | `oklch(0.92 0.038 40)` | selected row, hover tint |
| `--color-accent-200` | `oklch(0.86 0.07 40)` | borders on accent surfaces |
| `--color-accent-300` | `oklch(0.78 0.105 40)` | |
| `--color-accent-400` | `oklch(0.71 0.135 40)` | dark-mode links/accent text |
| `--color-accent-500` | `oklch(0.64 0.155 40)` | icons, accents (≈ brand #D85A3D) |
| `--color-accent-600` | `oklch(0.55 0.16 40)` | **primary action** (white text) |
| `--color-accent-700` | `oklch(0.48 0.145 40)` | primary hover/active |
| `--color-accent-800` | `oklch(0.42 0.115 40)` | |
| `--color-accent-900` | `oklch(0.36 0.09 40)` | |

In **dark**, links/accent-text use `accent-400` for contrast; primary buttons keep `accent-600` +
white text.

### Neutrals

| token | light | dark |
|---|---|---|
| `--color-bg` (page) | `oklch(0.99 0.003 285)` | `oklch(0.18 0.012 285)` |
| `--color-surface` (rows/cards/panels) | `oklch(1 0 0)` | `oklch(0.215 0.014 285)` |
| `--color-surface-2` (sidebar/toolbar) | `oklch(0.975 0.005 285)` | `oklch(0.16 0.012 285)` |
| `--color-border` | `oklch(0.92 0.006 285)` | `oklch(0.30 0.012 285)` |
| `--color-ink` (primary text) | `oklch(0.24 0.012 285)` | `oklch(0.96 0.005 285)` |
| `--color-muted` (secondary text — AA on surface) | `oklch(0.47 0.012 285)` | `oklch(0.72 0.012 285)` |

### Semantic roles — color is the *secondary* cue; iconography + text lead (a11y)

| token | value (light) | use |
|---|---|---|
| `--color-folder` | `accent-500` | [[Folder]] icon — the navigational backbone wears the accent |
| `--color-site` | `oklch(0.60 0.12 200)` (teal) | [[Site]] icon only — the one extra hue; Sites are the "live content" differentiator |
| `--color-file` | `--color-muted` | all [[File]] icons (pdf/img/video/md/generic) distinguished by **glyph**, not hue |
| `--color-edit` | `oklch(0.70 0.12 70)` (amber) | "Can edit" grant badge |
| `--color-danger` | `oklch(0.58 0.20 25)` | destructive (Delete, revoke) |
| `--color-success` | `oklch(0.62 0.14 150)` | upload/grant success toasts |
| `--color-info` | `accent-600` | info |

Interactive **state vocabulary** (standardize everywhere): default / hover / focus-visible / active /
disabled / selected / loading / error. Focus ring = `accent-500` at 2px offset.

## Typography

- **One family**: refined system-ui stack (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`)
  for all UI/body/data — zero font load, product-appropriate. The **wordmark** ("Handoff") is the same
  family at weight 700, letter-spacing -0.02em, accent-600 — personality without a display font.
- **Fixed rem scale**, ratio ~1.2: `xs .75 / sm .875 / base 1 / lg 1.125 / xl 1.25 / 2xl 1.5 /
  3xl 1.875`. Headings lead with **weight** (600–700), not size.
- Prose (markdown viewer) capped 65–75ch; tables may run dense. `text-wrap: balance` on headings.

## Spacing, radius, depth

- Spacing rhythm on a 4px base; vary section spacing (don't uniformly pad).
- Radius: `--radius-sm .375 / md .5 / lg .75 / xl 1rem`. Rows/inputs `md`, panels/menus `lg`,
  dialog `xl`.
- Shadow scale (tinted, very low chroma at hue 285): `sm` (rows on hover), `md` (menus/popovers),
  `lg` (Share dialog / modal). In dark, lean on `surface`/`border` elevation over heavy shadow.

## Motion

- Durations: `--dur-fast 150ms / --dur 200ms / --dur-slow 300ms`. Easing
  `--ease: cubic-bezier(0.25, 1, 0.5, 1)` (ease-out-quart). No bounce/elastic.
- Motion conveys **state** only: menu/dialog open (fade+scale-from-95%), toast slide-in, row hover,
  selection, skeleton shimmer, list-stagger on first folder load (subtle). No page-load choreography.
- Every animation has a `@media (prefers-reduced-motion: reduce)` crossfade/instant fallback.

## Z-index scale (semantic, no magic numbers)

`--z-dropdown 1000 / --z-sticky 1100 / --z-backdrop 1200 / --z-modal 1300 / --z-toast 1400 /
--z-tooltip 1500`.

## Components (each ships all states)

- **Sidebar tree**: `surface-2`, current folder = `accent-100` bg + `accent-700` text + left
  caret; lazy rows, skeleton on expand.
- **Listing table**: `surface` rows, hover `accent-50`/`shadow-sm`, sortable header (caret on active
  col), kebab reveals on hover (always visible on touch).
- **Menus** (New ▾, kebab): native `<dialog>`/popover or fixed-position to escape overflow clipping;
  `shadow-md`, `radius-lg`.
- **Share dialog**: native `<dialog>`, `shadow-lg`, `radius-xl`, backdrop, focus-trapped.
- **Toasts**: top-right stack, `--z-toast`, auto-dismiss, slide+fade, reduced-motion = fade.
- **Empty states**: accent-tinted glyph + teaching copy + primary "New ▾" CTA; per-context.
- **Skeletons** for loading (table rows + tree), never centered spinners in content.
- **Favicon**: `public/favicon.svg` — an accent-600 mark on transparent (currently 404s).
