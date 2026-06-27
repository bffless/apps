# Product

## Register

product

## Users

**Primary: the uploader/manager** — a member of an organization using Handoff to gather docs,
prototypes, and HTML, organize them into a [[Folder]] tree, control who can see each folder, and hand
them off to a team. They are in a task: uploading, sorting, naming, granting access, copying links.
They value speed, density, and clarity over spectacle, and they return often.

**Secondary: the recipient/viewer** — someone who receives a handoff and opens content, often a guest
with no account arriving via a [[Share Link]]. Their moment is opening a link and seeing live content
(an HTML [[Site]] rendered, a PDF, an image, markdown) without friction.

One Handoff deployment = one BFFless project = one organization. The BFFless instance is the tenant
boundary; there is no in-app account creation.

## Product Purpose

Handoff is an internal content-sharing app built on BFFless: upload content without git, organize it
in folders, control per-folder access, and serve it back so HTML renders **live**, not just
downloads. It is also a **give-away app that demonstrates BFFless** in videos and demos — so it must
look intentional and memorable, not generic. Success = an uploader can get content in, organized, and
shared in seconds, and a recipient can open a link and immediately see the content.

## Brand Personality

Confident, modern, crafted. A **bold, coherent identity** carried by one signature violet/indigo
accent — but expressed through a **calm, dense, familiar working surface**, not a loud one. Delight
lives in *moments* (empty states, the upload-success beat, hover/selection micro-interactions, a
characterful favicon), never smeared across every page. The tool should disappear into the task; the
identity should be unmistakable the moment you notice it. Three words: **crafted, decisive, quiet-bold.**

## Anti-references

- **Generic SaaS gray/white** — the current state; reads as unfinished and forgettable in a demo.
- **The cream/sand/parchment AI-default** body background. Not warmth-by-default.
- **Incoherent multi-hue palettes** (today's ad-hoc blue folders + purple uploads + amber badges).
  One signature accent, applied through semantic roles.
- **Mimicking the BFFless brand.** Handoff has its *own* identity (decision in ADR-0003); it should
  not look like a reskinned parent product.
- **Loud, over-decorated product chrome** — gradient-text, glassmorphism, decorative motion,
  big-number hero templates. Bold identity ≠ noisy UI.

## Design Principles

1. **Content is the star.** The chrome frames uploaded Files and rendered Sites; it never competes
   with them. Especially true around the viewer iframe.
2. **One accent, used with intent.** The violet/indigo accent marks primary action, current
   selection, and state — not decoration. Everything else is a tuned neutral.
3. **Density serves the manager.** The listing is a scannable table; familiar affordances (sortable
   columns, kebab menus, a folder tree) over invented ones. The tool disappears into the task.
4. **Delight in moments, not pages.** Spend personality on empty states, the upload beat, and
   micro-interactions; keep working surfaces calm.
5. **Private by default, legible always.** Who-can-see-this is never ambiguous; access and sharing
   read as one coherent idea.

## Accessibility & Inclusion

- **WCAG AA**: body text ≥4.5:1, large/UI text ≥3:1, in **both light and dark** themes (dark ships
  this pass with a header toggle; default follows system preference).
- **`prefers-reduced-motion`**: every animation has a crossfade/instant alternative.
- **Keyboard + focus**: menus (New ▾, kebab), the Share dialog, and the folder tree are fully
  keyboard-operable with visible focus and correct roles (`menu`, `dialog`, `tree`).
- Don't rely on color alone for file-type/state distinctions — pair with iconography and text.
