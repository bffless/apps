# Structural content storage for Handoff

**Status:** Design / approved direction
**Date:** 2026-07-05
**Author:** Handoff maintainers (via Claude)

## Problem

Viewing an uploaded Markdown file that references relative assets (`![](assets/foo.png)`)
renders with **broken images**. Three design choices combine to cause this:

1. **The bucket is flat and hash-keyed.** On upload the client sends only a *basename* to
   `POST /api/uploads/prepare`; CE's `presigned_upload` → `UploadRecordService.buildUploadKey`
   mints `{owner}/{repo}/uploads/content/{uuid}-{sanitizedFilename}`. The UUID prefix and the
   `originalName.replace(/[^a-zA-Z0-9._-]/g, '_')` slash-flattening **discard the relative
   structure** the user dropped. `assets/foo.png` becomes `content/<uuid>-assets_foo.png`.

2. **Structure survives only in side-maps a browser cannot traverse.**
   - **Sites** carry a DB `manifest` mapping `relPath → hashed key`; the `/api/sites/*` serve
     endpoint resolves each relative request through it. This is the "database map" we want gone.
   - **Folder imports** (a dropped folder of Markdown with no `index.html` — the case that broke)
     have *no manifest*. Each file becomes an independent `File` node; the Markdown and its
     `assets/` images are unrelated leaves with unrelated hashed keys.

3. **Markdown renders at the SPA route.** `MarkdownPreview` injects rendered HTML at
   `/view/<uuid>`, so `<img src="assets/foo.png">` resolves against `/view/assets/foo.png` — a
   route that serves nothing. Even a structural bucket would still break here without a base URL.

A correct fix touches **storage layout**, **serving**, and **the viewer**.

## Goal

Make relative references **just work** with no rewriting of stored Markdown/HTML and no DB path
map: the path a user sees in the UI *is* the storage key. This is BFFless's path-addressable
content serving (like deployment static hosting), but **mutable and human-named** — no git SHA, no
deployment version, no UUID. Handoff is currently built on the wrong primitive (pipeline uploads,
UUID-hashed for data-table collision-safety); it should be built on path-addressable content.

## Decisions (locked)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Storage scope | **Whole logical tree** mirrored on the bucket | Human-browsable; relative refs resolve across siblings; matches how BFFless content serving works |
| Existing content | **Greenfield / wipe** | Confirmed disposable; app is not in real use yet — removes all migration/compat complexity |
| Rename/move cost | Deferred | Handoff has **no rename/move today** (`FolderView.tsx`: "reserved for when their endpoints exist"), so structural keys carry no current copy cost |

## Target model

### Bucket layout mirrors the tree

A file's storage key is its **live folder path + name**, verbatim:

```
{owner}/{repo}/uploads/content/Design Docs/Q3 Handoff/doc.md
{owner}/{repo}/uploads/content/Design Docs/Q3 Handoff/assets/foo.png
```

- The `handoff_nodes` record stores this full `path` (relative to `content/`). It is **immutable**
  (no rename/move), so it never needs rewriting.
- **Names are preserved verbatim.** S3/MinIO keys allow spaces and unicode; the browser will
  request the relative ref exactly as written in the Markdown, so the stored key must match it
  byte-for-byte. We therefore do **not** character-sanitize. We only **reject** unsafe input:
  `..` segments, control chars, empty segments, a leading `/`, or a total key over the bucket
  limit (~1024 bytes). URL encoding happens only at the HTTP layer.
- ACL is unchanged: it comes from the **DB folder chain** (parentId walk), not from storage.

### Sites unify onto the same model (manifest retired)

A Site's files store under the site's own path prefix and serve through the *same* content
endpoint:

```
{owner}/{repo}/uploads/content/Design Docs/prototype/index.html
{owner}/{repo}/uploads/content/Design Docs/prototype/assets/app.js
```

- The site node keeps `path` (`Design Docs/prototype`) and `siteEntry` (`index.html`).
- The `manifest` field and the dedicated `GET /api/sites/*` route are **deleted**. Relative
  resolution for both Sites and Documents becomes pure path passthrough.
- The Site iframe `src` becomes the entry's content URL:
  `/api/uploads/content/Design Docs/prototype/index.html`.

## Serving

One unified endpoint: `GET /api/uploads/content/<path>` (the existing rule, generalized).

1. **Parse** `<path>` from the URL (already done in the current `parsePath` handler).
2. **Authorize.** Load folder nodes (as today via `allFolders`) and find the **deepest folder
   node whose `path` is a prefix** of `<path>`; run the existing ACL gate over that chain.
   - Guard against serving unregistered objects: the path must resolve to **either** a file node
     at the exact `<path>` **or** a descendant of a `site` node whose `path` is a prefix.
     Otherwise 401/403/404 as appropriate. This preserves the current gate semantics while
     covering site-internal assets that are not their own nodes.
3. **Serve** the object at `content/<path>` via `file_serve_handler` (serves by exact key today).

The serve side needs little change beyond the prefix-based ACL lookup — `file_serve_handler`
already serves by exact path.

## CE enhancement (required — no clean app-only path exists)

`buildUploadKey` always UUID-prefixes and slash-flattens the filename, so structural keys are
impossible today. `subDir` is expression-driven and preserves slashes, but the filename is still
UUID-prefixed on top. Any app-only workaround reintroduces a map.

**Add a verbatim-key mode to `presigned_upload` and `register_upload`:**

- New optional config: `keyStrategy: 'uuid' | 'verbatim'` (default `'uuid'`, preserving current
  behavior for all existing consumers) plus a `key` (a.k.a. `path`) expression resolving to the
  sub-path under `subDir`.
- In `verbatim` mode `UploadRecordService.buildUploadKey` produces
  `storageKey = {owner}/{repo}/uploads/{subDir}/{key}` and
  `publicPath = /api/uploads/{subDir}/{key}` with **no UUID prefix** and **no slash-flattening**;
  it applies only the safety rejections above (`..`, control chars, empty, leading `/`,
  over-length). `parseUploadKey` gains a matching verbatim branch (no UUID strip).
- `register_upload` accepts and verifies the verbatim key the same way.

This is a general, reusable BFFless feature — "presigned upload to an app-controlled key/path" —
not a Handoff-specific hack. It ships as a CE PR + release, consistent with the workspace's
"enhancing CE is first-class" rule.

## Frontend changes

### Upload / import

- `POST /api/uploads/prepare` sends the **target sub-path** (folder path + name), not a basename,
  and the pipeline uses `keyStrategy: 'verbatim'` with `key = request.body.path`.
- Folder import (`planFolderImport`) and Site upload (`planSiteUpload`) pass each file's **exact
  normalized relative path** as `key`, preserving the dropped structure. Within one import,
  relative paths are authoritative and never renamed.
- A single-file upload into folder `F` uses `key = <F.path>/<filename>`.
- Node registration stores the file's full `path`.

### Viewer (fixes the broken images)

Render Markdown into an **iframe** via `srcdoc`:

- Inject `<base href="/api/uploads/content/<folder-path-of-the-doc>/">` so `assets/foo.png`
  resolves to the real sibling content URL — **no rewriting of the stored `.md`**.
- Inline the app's `.markdown-body` CSS into the `srcdoc` so rendered docs keep their styling
  inside the iframe.
- Keep the existing DOMPurify sanitization before injecting.
- This mirrors how Sites already render (same-origin iframe; see ADR-0001 for the same-origin
  tradeoff, which continues to apply).

### App rules (uniqueness)

- `/` is the reserved delimiter; names are otherwise verbatim.
- Within one folder, a name identifies content. **Cross-operation collisions** (e.g. uploading a
  second `doc.md` into a folder that already has one) are **rejected with a clear error** — not
  overwritten or auto-suffixed, because auto-suffixing would break relative refs that expect the
  original name. (Within a single import, the dropped paths are the source of truth and are kept
  verbatim.)

## Non-goals / deferred

- **Rename/move.** Out of scope; does not exist today. When added, it will require a server-side
  subtree copy+delete (S3/MinIO have no atomic rename). That known future cost was accepted when
  choosing whole-tree structural storage.
- **Migration/compat for old content.** None — greenfield wipe.
- **Sandboxing the Site/Markdown iframe.** Unchanged from ADR-0001 (intentionally same-origin,
  unsandboxed, for trusted internal uploaders).

## Rollout

The CE change is normal in-loop platform work; the app change follows the project's established
`to-prd` → `to-issues` flow for Sandcastle (not superpowers plans or ad-hoc issues).

1. **CE first (interactive, `repos/ce`):** implement + test the verbatim-key mode; open PR;
   release. This is the hard blocker for everything below — the live `handoff` project's proxy
   rules cannot call `keyStrategy: 'verbatim'` until the deployed CE supports it.
2. **`/to-prd`** (after CE lands): synthesize this conversation + this spec into a PRD published to
   the `bffless/apps` tracker, labelled `ready-for-agent`.
3. **`/to-issues`:** break the PRD into vertical-slice (tracer-bullet) issues for Sandcastle —
   e.g. verbatim upload wiring, unified serve + retire `/api/sites/*`/`manifest`, viewer
   iframe+base, uniqueness rule. Each issue notes the CE-release dependency.
4. **Sandcastle executes** the issues against `handoff.proxy-rules.json` + the frontend.
5. **Live proxy rules via MCP:** create/update the live `handoff` rule set (Sandcastle does not
   deploy live proxy rules).
6. **Wipe** existing Handoff content and DB nodes (greenfield).

## Risks

- **CE dependency.** The redesign cannot land app-only; it blocks on a CE PR + release.
- **Deep trees / long keys.** Enforce a max total key length (~1024 bytes) at upload time.
- **Same-origin iframe.** Markdown now renders same-origin (like Sites). DOMPurify sanitization is
  retained; the ADR-0001 tradeoff continues to apply.
```
