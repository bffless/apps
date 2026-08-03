# Product

## Register

product

## Users

Creators and developers who recorded one long, rambly screen recording (a demo, a walkthrough, a talk rehearsal) and want a short, watchable video cut from it in their own recorded voice. They work solo, at a desk, in a focused editing session — the footage and its transcript are the object of attention, and the tool is the surface they look *through*, not *at*.

## Product Purpose

Studio turns a long screen recording into a short video via cut-first editing: an AI "master director" splits the recording into scenes and proposes cuts, the producer tunes the cuts scene by scene, and export stitches the kept spans in-browser with ffmpeg.wasm. Nothing is re-voiced and the AI never rewrites what was said. Success is the fastest honest path from raw recording to shareable cut.

## Brand Personality

Precise, calm, focused. Quiet confidence: the UI recedes so footage, filmstrips, and transcript carry the visual weight. No decoration for its own sake.

## Anti-references

- **The bffless.app landing-site look** — taupe paper background, terracotta accent, serif display headings, dot-grid texture, corner brackets. Studio previously wore this and must not read as a marketing page.
- **Rivulet (sibling reader app)** — its polish is the quality bar, but its slate + blue + system-font look is not to be cloned; Studio has its own identity.
- **"Creative tool" clichés** — gradient text, glassmorphism, hero metrics, decorative motion.

## Design Principles

1. **The footage is the color.** Chrome stays neutral; the accent marks actions, selection, and state — never decoration.
2. **Honest names.** Tokens describe roles (surface / ink / line / accent), never colors they don't have.
3. **Familiar affordances.** Standard controls and one consistent component vocabulary across all four phases (Import → Prep → Build → Export).
4. **State is visible.** Every interactive element has hover / focus / active / disabled / loading; long-running pipeline stages show clear progress.
5. **Motion conveys state.** 150–250 ms, ease-out, nothing orchestrated; reduced-motion users get instant alternatives.

## Accessibility & Inclusion

WCAG AA: body text ≥ 4.5:1 contrast (large text ≥ 3:1), visible focus outlines on every interactive element, `prefers-reduced-motion` alternatives for all animation, and color never the sole carrier of state.
