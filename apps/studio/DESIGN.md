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

- Inter everywhere; headings (`h1`–`h3`) are `font-semibold` with `-0.015em`
  tracking (base CSS), `text-wrap: balance`; the component-level utility sweep
  uses `tracking-[-0.01em]` as a variant on non-heading emphasis text.
- JetBrains Mono ONLY where mono is functional: timecodes, durations, cut
  ranges, `.meta-label`. `.font-mono` gets `tabular-nums` globally.
- Base 16px / 1.5; component sizes are currently fixed px values, converging
  on a ~1.125 rem scale; no fluid clamp headings.

## Components

- Controls 6px (`rounded-md`). StageCard is the reference raised card
  (`rounded-lg` on `surface-raised`); most legacy cards are still flat
  `bg-surface` with hairline borders and migrate incrementally.
- `.pill-cta` accent fill / white text; `.pill-ghost` `line` border, `surface-dim` hover fill.
- StageCard establishes the full-border active treatment; five legacy
  side-stripe accents (DirectorPanel, SynopsisCard, SceneAssembleBar,
  SceneList active item, SourceQueue drag target) remain and migrate
  incrementally.
- `.meta-label`: 11px mono uppercase, 0.08em tracking, `ink-mute`.
- Focus: global `:focus-visible` 2px accent outline. Motion 150–300ms ease-out,
  with a `prefers-reduced-motion` collapse.

## Accessibility

WCAG AA. Body text ≥4.5:1; visible focus everywhere; color never the sole
state carrier (steppers/cards pair color with glyphs and labels).
