---
name: image-prompts
description: Generate detailed, reliable prompts for image generation models (Midjourney, DALL-E, Gemini, Imagen, etc.). Use when the user asks for a thumbnail, blog hero, social ad creative, OG image, marketing illustration, or any "give me a prompt for an image" request. Covers the canonical prompt anatomy and named house styles routed by content type — retro-blueprint for tutorial / walkthrough videos, modern-dev-tool for watch-me-code / live-build videos, electric-poster for BFFless give-away app showcase videos, editorial-print for long-form blog heroes — plus how to extract and reuse a style from a reference image.
---

# Image Prompts

Generate prompts that produce predictable, on-brand images on the first try — instead of vague one-line prompts that need 10 re-rolls.

## When to use

- User asks for a prompt for image gen ("give me a prompt for…", "write a prompt for the thumbnail", "I need DALL-E text for X")
- User wants a YouTube thumbnail, blog hero, OG image, social ad, illustration
- User shares a reference image and wants "another like this" or "in this style"
- User wants to brief a designer or another LLM with a structured visual spec

Do NOT use for:

- Actually generating the image (this skill produces text — the user feeds it into Midjourney/DALL-E/Gemini themselves)
- Logo design or brand identity work (different problem — needs iteration loop, not single prompt)
- HyperFrames video compositions (use the `hyperframes` skill)

## Workflow

### 1. Understand the brief

Ask just enough to lock the spec. Don't ask all four — pick the 1–2 that aren't already obvious from context.

- **Purpose** — YouTube thumbnail, blog hero, ad creative, OG image, decorative illustration? (Different aspect ratios, different rules.)
- **Subject** — what is it about? Pull a clear noun-phrase, not "a video about platform stuff."
- **Style** — does the user want a known house style, a reference image, or fresh exploration?
- **Constraints** — must-include text? Brand colors? Things to avoid?

If the user pastes a reference image, **read it first** (the Read tool works on local images). Don't write the prompt from your imagination of what they sent.

### 2. Pick a style anchor — by content type first

**The style anchor is a 1:1 routing decision from content type, not a vibe call.** Picking the wrong content type produces an on-brand-but-wrong thumbnail — it will look great and the user will tell you it's the wrong kind of thumbnail for the video. Read the brief for content-type signals BEFORE thinking about visuals.

| Content type signal                                          | → Style anchor       | Anchor phrase                                                       |
| ------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------- |
| **Tutorial / walkthrough / explainer** — teaches a concept, "how does X work", multi-handler/architectural diagrams, "let me show you" framing | **retro-blueprint**  | "vintage technical manual, parchment background, hand-drawn schematic" |
| **Watch-me-code / live-build / "1 sitting" / ship-a-feature-now** — building something specific in one session, end deliverable shown, "I'm gonna build X right now" framing | **modern-dev-tool**  | "Vercel/Linear/Railway thumbnail energy, dark navy, code editor mock, cyan underline accent" |
| **App showcase / give-away app** — showing off a finished BFFless app (Studio, etc.), "this app is free, clone it" framing, the app's UI is the star, not the process of building it | **electric-poster**  | "product-launch poster, flat electric violet field, app UI in a straight-on browser window, FREE APP pill" |
| **Long-form blog hero / thought-leadership / research piece**| **editorial-print**  | "magazine cover, generous white space, single bold typographic statement" |

**Disambiguation rule when more than one could fit:** does the video teach a concept (tutorial → retro-blueprint), ship a deliverable in one sitting (watch-me-code → modern-dev-tool), or show off a finished give-away app (app showcase → electric-poster)? Watch-me-code shows the *building*; app showcase shows the *built thing* — if the thumbnail's hero is the app's own UI rather than a code editor, it's electric-poster. When in doubt, ask the user which content-type the video is before picking the anchor.

**Creator wishes outrank the routing.** If the brief or NOTES name a house style ("tutorial theme", "watch-me-code look"), use that style — do not re-route to a different one because the notes also ask for something that style avoids by default. A deviation ("tutorial theme but with a dark background", "put the presenter in the centre") is a *variant* of the named style: keep its content-type markers (the `TUTORIAL · S01 EP##` strip, body copy and hand-drawn schematic for tutorial; the `WATCH ME CODE` pill and editor mock for watch-me-code), apply the deviation, and drop the contradicted item from the negatives. A creator who asked for dark tutorial wants a tutorial that is dark, not a watch-me-code thumbnail.

Other valid choices (custom, hand-drawn, isometric, photographic, 3D render) — but always name the anchor explicitly. "Make it pop" is not a style; "Braun product brochure crossed with Linear" is.

If the user shared a reference: extract the anchor from it (background color, typography weight, illustration technique, accent color count, visible textures). Name the anchor explicitly in the prompt — image models latch onto named references better than descriptions.

### 3. Write the prompt using the anatomy below

Every prompt should hit these sections **in this order**. Skipping sections produces vague results.

```
1. Format line — aspect ratio + medium ("16:9 YouTube thumbnail", "1200×630 OG image", "square Instagram ad")
2. Style anchor — one sentence naming the visual reference ("vintage technical manual style, like a 1970s IBM brochure")
3. Composition — what's where on the canvas (left half / right half / top strip / bottom row)
4. Typography — exact headline text, weight, font family hint, stack order
5. Subject/illustration — what the focal artwork shows, including specific objects and labels
6. Accent details — small icons, badges, decorative marks, single-color pops
7. Color palette — 3–4 named colors with hex codes, capped at the smallest workable set
8. Style descriptors — adjectives that reinforce the anchor ("confident, editorial, slightly nerdy")
9. Negative list — what to avoid (photorealistic humans, generic clouds, drop shadows, gradient mesh)
```

### 4. Cap the text

Image models can't render long copy reliably. Hard limits:

- Hero headline: **≤ 5 words**
- Secondary line / pill / badge: **≤ 3 words**
- Body copy block: **≤ 25 words, and only if the style is editorial/magazine** (skip on thumbnails)
- Tiny metadata strips: **≤ 6 short tokens separated by bullets**

If the user wants more text, push back — suggest splitting it into a series or letting the design tool handle text overlay separately.

### 5. Lock the color count

Three colors is the sweet spot. Four is okay. Five+ usually muddles results.

Always give hex codes — "navy blue" is interpreted dozens of ways; `#0B0F2C` is one.

### 6. Write a negatives list

This is the highest-leverage section. Models love to add: gradient mesh, neon glow, photorealistic people, generic cloud icons, drop shadows, busy backgrounds, every cliché SaaS-landing-page detail. List them out explicitly. Never list something the creator asked for — if NOTES want a dark background, "dark mode" does not go in the negatives, whatever the house style says by default.

## House styles

Each style ends with an **Avoid by default** list. Those are defaults for a brief that says nothing about style — they keep the four styles distinct from one another. They are not vetoes: an explicit creator wish (NOTES, the brief, a named reference) overrides any single item, and that item must then NOT appear in the prompt's negatives list. Everything else in the style still applies.

## House style: retro-blueprint (tutorial / walkthrough)

For BFFless **tutorial / walkthrough / explainer** videos and editorial content. Reference: the auth-tutorial and first-deployment thumbnail style.

- Background: cream/parchment `#F1E9D5` with faint paper grain
- Type: heavy black grotesque (Inter Black / Söhne Breit feel), 2–3 line stacked headline
- **Content-type marker:** top metadata strip ALWAYS includes `TUTORIAL` and an episode tag like `S01 EP15`, bullet-separated in monospace. Above the headline, a thin category line in mono (e.g. `OPEN SOURCE / SELF-HOST`, `AUTH`, `PIPELINES`).
- **Body copy paragraph:** 3–4 lines of small justified grotesque beneath the headline describing what the tutorial covers — this is unique to tutorials, watch-me-code does NOT use it.
- Illustration: hand-drawn schematic in ink `#1A1A1A`, wireframe boxes, dotted lines, pencil arrows, tiny handwritten labels
- Accent: single bright red `#E63946` used sparingly (1–2 places max)
- Bottom row: 3–4 small boxed category labels with hand-drawn icons (handler names, system primitives)
- Vibe descriptor: "1970s technical manual meets modern editorial"
- Avoid by default: gradient mesh, neon glow, dark mode, photorealism, drop shadows, 3D renders, code editor mocks (those are watch-me-code territory)

## House style: modern-dev-tool (watch-me-code)

For BFFless **watch-me-code / live-build / "1 sitting"** videos. Reference: the "INSTALL CHAT SDK WITH BFFLESS" thumbnail style (Vercel/Linear/Railway aesthetic with a twist).

- Background: dark navy `#0B1226` flat fill with a faint dot grid (NOT a radial gradient, NOT line grid — small dots in a regular matrix at ~6% opacity)
- Type: heavy white sans-serif (Inter Black / Söhne Breit), 2–3 line stacked headline. Tighter line-height than retro-blueprint.
- **Content-type marker:** small `WATCH ME CODE` pill at top-left — thin rounded badge, white text, hairline cyan-or-white border, ~3% the height of the canvas. This is the unmistakable watch-me-code signal.
- **Proof artifact accent:** the portion of the headline that names the thing being built (a URL like `/install.sh`, a phrase like `WITH BFFLESS`, a stack name) gets a hand-drawn cyan underline `#22D3EE` — a single confident stroke, not a perfect rectangle. This is the live-build mark.
- **Footer line** beneath the headline: tiny uppercase or mixed-case monospace, bullet-separated tokens like `github · j5s.dev · 1 sitting` or `bffless.app · pipelines · live`. The "1 sitting" / "live" framing is the watch-me-code tell.
- Illustration: code editor mock with traffic-light dots, monospaced syntax-highlighted JSX / HTML / TS / shell — NOT a generic browser window, NOT a schematic. Slight tilt (~6°), thin neon outline.
- Code text in the mock: at most three short REAL tokens the viewer could read (a keyword, a handler name, a path) — render the remaining lines as abstract syntax-coloured bars or softly blurred lines. Image models cannot spell code; a mock full of legible near-code ("ccreate_record: afex_record") reads as a typo across the whole thumbnail.
- Accent: electric cyan `#22D3EE` for the underline, mark, and editor outline. Optional sparing magenta `#D946EF` for a single highlight (one tick mark, one icon). Maximum 2 accent uses on the canvas.
- Decorative: a few small cyan dots or dashes in the empty corners for negative-space rhythm — sparing, not a particle field.
- Vibe descriptor: "confident, restrained, live-build energy, every element load-bearing"
- Avoid by default: parchment textures, hand-drawn schematic diagrams (tutorial territory), `TUTORIAL` or `S01 EP##` tags (tutorial territory), body copy paragraphs (tutorial territory), violet poster fields / `FREE APP` pills / app-UI-as-hero (app-showcase territory — watch-me-code shows the code, not the finished product), photorealistic humans, busy backgrounds, radial gradients, neon glow on the headline itself (only the underline + editor outline glow)

## House style: electric-poster (app showcase / give-away)

For **BFFless apps** videos — showing off a finished give-away app (Studio, and each new app in the monorepo). The video's pitch is "here's a polished app, it's free, clone it onto your own BFFless" — so the thumbnail sells a *finished product*, not a process. The app's own UI is the hero.

- Background: flat electric violet `#5B5BD6`, solid fill — NO gradient, NO texture. The saturated field is the style's instant tell at feed size.
- Type: heavy white sans-serif (Inter Black / Söhne Breit), 2–3 line stacked headline. Line 1 is the APP NAME; the remaining line(s) say what it does in ≤5 words (e.g. `STUDIO` / `RE-VOICE YOUR` / `SCREEN RECORDING`).
- **Content-type marker:** small `FREE APP` pill at top-left — solid amber `#FBBF24` fill, near-black ink text, crisp 4px corner radius (not a bubbly capsule). This is the unmistakable give-away signal.
- **App-name underline:** the app name gets a hand-drawn WHITE underline — single confident stroke, same gesture as watch-me-code's cyan underline but white-on-violet. This keeps the family resemblance while staying unambiguous.
- **Footer line** beneath the headline: tiny monospace at ~60% opacity, bullet-separated tokens like `clone it · bffless.app · open source`. The "clone it" framing is the give-away tell.
- Illustration: the app's REAL UI in a clean browser window — straight-on, NOT tilted (tilt is watch-me-code territory), traffic-light dots, thin white hairline border, 4px corners, soft lift shadow for separation. Show recognizable product UI (panels, timeline, waveform, whatever the app actually looks like) — NOT a code editor, NOT syntax highlighting.
- Accent: single warm amber `#FBBF24`, used at most twice — the pill, plus optionally one tiny mark (a small ✳ spark near a corner, or one highlighted element inside the app UI). Nothing else gets the accent.
- Decorative: one or two small white ✳ spark/asterisk marks in the empty corners — sparing, hand-drawn feel, not confetti.
- Vibe descriptor: "product-launch poster, confident give-away energy, a finished thing you can have"
- Avoid by default: dark navy backgrounds + code editor mocks (watch-me-code territory), parchment / hand-drawn schematics / `TUTORIAL` or `S01 EP##` tags (tutorial territory), body copy paragraphs, gradients of any kind, glassmorphism, 3D device renders, phone mockups, tilted windows, big rounded corners (keep radii crisp at ~4px), more than one accent color, photorealistic humans

## House style: editorial-print

For long-form blog heroes, research-style posts.

- Background: off-white `#F8FAFC` or warm cream `#FDF6E3`, generous margins
- Type: large editorial serif (Tiempos Headline, GT Sectra feel) OR ultra-condensed grotesque, single bold typographic statement
- Illustration: minimal — one strong abstract mark, single photograph treated with duotone, or no illustration at all
- Accent: single ink color (deep navy, burgundy, forest)
- Vibe descriptor: "magazine cover, restrained, thought-leadership"
- Avoid by default: multiple illustration elements, neon, gradients, anything that screams "tech"

## Working from a reference image

When the user shares a reference:

1. **Read it.** Use the Read tool — the user gave you the file path for a reason.
2. **Name what you see.** Background color (estimate hex), typography weight, illustration technique (hand-drawn? vector? 3D?), color count, texture, era cues (vintage manual? 80s sci-fi? 2010s flat?).
3. **Reuse the named anchors.** "In the style of [reference]" only works if you name what the reference *is* — "vintage technical manual" beats "the image I just looked at."
4. **Don't copy the subject — copy the treatment.** The user wants a new thumbnail for *their* video, not a duplicate of the reference. Keep the style, swap the content.

### When the reference is handed to the image model

Some pipelines pass the reference to the generator itself (nano-banana's `image_input`, Imagen's reference input) rather than only to you. Then it is not a style source — the output is meant to **contain** it, usually the creator's own face. The model still ignores it unless the prompt says to use it, so:

1. **Name it in the Subject section.** "Use the attached reference photo of the presenter — same face, same person, cut out from its background" — then place them ("right third, shoulders up, facing left").
2. **Compose for a person.** Give them 30-40% of the canvas; keep the headline and any diagram out of that space.
3. **Drop "photorealistic humans" from the negatives.** It is the single line that cancels the attachment, and it **overrides the "always avoid" list of whichever house style you picked.** Ban invented people instead: "extra people, invented faces, stock-photo models, altered likeness".

Rule 3 is the one that gets missed: a prompt can attach a photo, describe a full illustration, and forbid humans all at once — and the result is a clean thumbnail with no creator in it.

## Output format

When you produce a prompt, deliver it as one fenced code block the user can copy-paste directly into Midjourney/DALL-E/Gemini. No commentary inside the block. After the block, one short sentence offering tweaks (e.g. "swap the headline to X if you'd rather lead with Y").

If the user wants multiple variations, produce them as separate code blocks with a short label above each ("Variation A — confident", "Variation B — playful"). Don't merge them.

## Examples

See `examples.md` in this skill directory for full prompt examples in each house style.

## Anti-patterns

- One-line prompts ("a cool YouTube thumbnail about deployment"). Useless. Use the anatomy.
- "Make it pop" or "make it eye-catching" as style direction. Replace with named references.
- More than 5 colors. Cuts model precision.
- Vague headlines ("something about deployment"). Write the exact text.
- Missing negatives list. Lets the model fall back to clichés.
- Quoting the reference image without reading it. The user can tell.
