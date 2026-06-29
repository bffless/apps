# 12 — Companion blog post (Export deliverable)

> Read `00-architecture-and-state.md` first. Glossary: `../CONTEXT.md`
> (Companion blog post, Blog bundle, Final cut, Contact sheet).
> Decisions: `../docs/adr/0001-companion-blog-from-final-cut.md`,
> `../docs/adr/0002-blog-images-recaptured-not-cropped.md`.

**Status:** 🎯 designed (grilled), not built. **Backend: one new async AI pipeline +
one new upload asset type.**

## Goal

Turn the finished video into a **companion blog post**: same content and coverage as the
[[Final cut]], in blog format, so the creator can publish a written version alongside the
video. The output is a portable **Blog bundle** — a Markdown document plus an `images/`
folder of illustrating frames — that the creator downloads and hosts wherever they like.
Studio does **not** host or serve the post, and there is **no in-app editor** (this is not
a CMS — generate, preview, download).

It lives as a **Blog card in the Export step**, alongside Description, Final cut, and
YouTube thumbnail — a parallel deliverable of the finished video, generated **on demand**.

## What feeds it

All of this already exists when Build finishes (the Export precondition):

- **Final narration script** — `videoScript(scenes)` (the re-voiced, kept narration). This
  is what the post *says*. (ADR-0001: companion to the final cut, not the raw transcript.)
- **Title + summary + synopsis** — the existing `/api/describe` output and director
  synopsis → H1, intro, and context.
- **Scene titles** — seed the section outline (the same titles that become YouTube
  chapters).
- **Contact sheets** — the existing whole-clip prep sheets (with burned-in timestamps),
  reused **verbatim** as the AI's eyes. Images may come from anywhere in the recording, not
  only kept footage (a reader can't tell second 142 was trimmed).
- **Direction** — an optional free-text box (mirrors the director's `direction` field),
  weighted heavily in the prompt, for tone/length/audience.

## Backend — `/api/blog` (new async pipeline)

Sibling of `/api/scenes` (the director): async fire-and-poll, multimodal Gemini 3.1 Pro,
strict JSON, truncation-tolerant.

- **Request:** `{ script, title, summary, synopsis, scenes: [{ title, transcript }],
  sheetUrls: string[] (≤10), direction, duration }`.
- **Shape:** enqueue → `{ jobId }`; the Gemini call runs in `postSteps`; FE polls
  `/api/studio/job`; `studio_jobs.kind = 'blog'`. Contact-sheet URLs are signed
  step-by-step in `postSteps` (same as the director).
- **Output envelope:** `{ "markdown": "..." }` — one Markdown string. (JSON envelope so the
  existing `studio_jobs` plumbing + truncation salvage apply unchanged. If real truncation
  shows up on long posts, graduate to a per-section fan-out — do **not** build that
  speculatively.)
- **Prompt rules (system):** faithful-but-prose — cover exactly what the video covers,
  expanded from terse narration into real paragraphs (transitions, the odd list/code block);
  **no invented facts/claims/examples**. Seed the outline from the scenes but stay elastic —
  may merge tiny scenes, split a long one, or rename a heading for flow. Emit the post as
  Markdown with **front-matter** (`title`, `description`) and place images **inline as
  tokens** keyed by timestamp + caption, e.g. `![caption](frame:142.5)`. Read the timestamp
  off the contact-sheet's burned-in clock. Render captions visibly (alt text **and** an
  italic caption line under each image). **Use images sparingly** — only where one genuinely
  illustrates the point (a step, a result); the post is prose-first, not a screenshot gallery.

## Front-end

State (durable, in `ProjectWorkingState` so it syncs to `studio_projects` via story 11d —
restorable cross-browser):

```ts
blog: {
  markdown: string          // resolved: image tokens rewritten to /api/uploads/blog/... URLs
  direction: string         // the creator's free-text steer
  script: string            // the final script it was generated from (staleness key)
  status: 'idle' | 'running' | 'done' | 'error'
  jobId?: string | null
} | null
```

Flow (a new `BlogCard` + orchestration in `useScenePipeline.ts`):

1. **Generate** (button; on demand, not auto — it costs a call). POST `/api/blog`, poll the
   job, get `{ markdown }`.
2. **Materialise images eagerly** (ADR-0002): parse the markdown for `frame:<t>` tokens,
   dedup timestamps; for each, map global→`(sourceId, localTime)` (`globalToLocal`, for
   multi-source), seek the **source video** (in-memory `File` if present, else signed bucket
   `sourceUrl`) and re-capture a clean full-res frame via `captureFramesAt`; upload each as a
   **new blog asset** (presigned direct-to-bucket, reuse the `studio_source` upload schema,
   `sub_dir: "blog"` → `projects/{id}/blog/frame-NN.jpg`). Get serve URLs.
3. **Rewrite tokens → real Markdown image links** at the bucket serve URLs. Persist *that*
   resolved markdown to the slice + DB.
4. **Preview** — render the resolved markdown **read-only** (a Markdown renderer dep, e.g.
   `react-markdown`). Same-origin `/api/uploads/...` images carry the auth cookie so they
   render in-app.
5. **Download bundle** — parse the current markdown's image URLs, fetch each from the bucket
   into a zip (small lib, e.g. `fflate`) under `images/frame-NN.jpg`, rewrite the URLs to
   those relative paths, add `post.md`, download `<title-slug>.zip`.
6. **Regenerate** — re-runs from the current script + direction, replaces the post. Auto
   stale-marking when `script` changes (re-build a scene), but **not** auto-rerun. No edit
   path: different images come only from Regenerate (nudge via the direction box).

## Non-negotiables (per `00-architecture-and-state.md`)

- **Mock-first**: add an MSW handler for `/api/blog` returning the same `{ markdown }` shape;
  coerce both routes through one pure `toBlog()`/parse fn. Pure logic (token parsing, slug,
  bundle assembly, global→local mapping) in `src/lib/*` with `*.test.ts`.
- **No base64 in Redux/localStorage** — blog frames persist **url-only** (they're real bucket
  assets); the captured bytes never enter the slice.
- **Presigned direct-to-bucket** for the frame uploads; never stream image bodies through the
  pipeline (1 MB nginx cap).
- After changing rules in the dashboard, **re-export** `bffless/studio.proxy-rules.json`.
- One stage per PR; `build`, `lint`, `test:run` pass.

## Open / deferred

- **Image density: restrained, additive.** Images appear **only where one genuinely adds
  value** (illustrates a step, shows a result) — **not** a screenshot per section. The post
  is prose-first; a frame is the exception that earns its place. Encode this as a prompt
  instruction (bias toward fewer), not a hard cap.
- **No gating** — this deployment is single-user/domain-authed; skip story 07's entitlement
  check for `/api/blog`. (Diverges from the give-away/Stripe framing; intentional here.)
- **Per-section fan-out** — only if single-call truncation proves real on long posts.
