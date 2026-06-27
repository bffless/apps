# Bold visual identity on a design-token system

**Decision.** Handoff gets a **distinct, bolder visual identity** built on a CSS-first **design-token
system** (Tailwind v4 `@theme`), anchored to a single **signature accent (violet/indigo)** that is
Handoff's own — not borrowed from the BFFless brand. All previously ad-hoc colors (blue folders,
purple upload controls, amber edit-badge, scattered grays) are replaced by semantic tokens: an
accent scale (`50→900`) plus role tokens for `folder`, `site`, `file`, `edit`, `danger`, surfaces,
borders, and text. Depth (a shadow scale) and motion (transition/duration primitives) are tokens
too. The app ships **light + dark** with a header toggle (default: system preference, then the
choice persists in `localStorage`).

**Why.**
- Handoff is a *give-away app that demos BFFless* in videos/demos as well as an internal tool — a
  memorable identity earns the demo, where the current restrained gray/white reads as generic.
- The palette today is **incoherent** (folders blue, uploads purple, badges amber, no accent token).
  One signature accent applied through semantic tokens makes the whole app feel intentional and makes
  future changes a one-token edit rather than a find-and-replace.
- Tokens are the substrate every other workstream sits on (listing, Add menu, Share dialog, empty
  states, motion), so the token layer is built **first**.
- Its **own** accent (not BFFless's) gives Handoff product identity; anchoring to the parent brand was
  considered and rejected for this pass.

**Consequence.**
- **Dark mode wraps light content.** Handoff renders user content in iframes ([[Site]]s, PDFs) and as
  light markdown prose. In dark mode the *app chrome* darkens but iframe'd content stays light — an
  accepted mismatch (an iframe is the uploader's own page; we don't restyle it). Dark treatments are
  authored for chrome, lists, panels, the source viewer, and markdown (`prose-invert`); motion honors
  `prefers-reduced-motion`.
- **Frontend-only.** This identity is pure UI: `src/**`, `index.css` (`@theme`), and a new
  `public/favicon.svg` (an accent glyph — the referenced favicon is currently 404). No proxy-rule or
  mock changes. See the scope note in [[#stories/01-ux-overhaul]].
- Existing component styling is migrated to tokens incrementally; no behavioral change is implied by
  this ADR — it governs *look*, not *flow*.
