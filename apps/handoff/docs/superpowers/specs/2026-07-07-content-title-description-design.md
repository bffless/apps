# Content Title & Description — feed-surfaced metadata — design

**Date:** 2026-07-07
**Status:** Approved (brainstorm), pending spec review

## Problem

Handoff's RSS [[Feed]] (merged in #187) renders each [[File]] / [[Site]] as a [[Feed Item]]
whose `<title>` is just the filename and whose `<description>` is auto-generated (an inline
`<img>` for images, a `name (size)` line for other files, the bare name for a Site). In a
reader like Rivulet the result looks empty — a wall of `Screenshot 2026-07-07 at 5.54.57 PM.png`
rows with no context.

We want the uploader to attach an optional **Title** and **Description** to any piece of
content from inside the Handoff UI (the file/site viewer), and have those flow into the feed
so subscribers see an authored `<title>` and a real body.

## Decisions (from brainstorm)

- **Title is an additive display override, not a rename.** The [[File]] keeps its filename as
  its identity everywhere (verbatim content path, folder listings, per-folder name-uniqueness).
  `title` overrides only the viewer heading and the feed item `<title>`, falling back to the
  filename when empty.
- **Description is plain text, multi-line.** XML/HTML-escaped into the feed `<description>`
  (newlines → `<br>`). No Markdown in v1.
- **Scope: [[File]] + [[Site]] leaves only.** Folders keep their auto channel title/description.
- **Out of scope (v1):** folder-level title/description → channel metadata; showing the title
  in folder listings.

## Key findings (verified)

- The `handoff_nodes` data table (schemaId `1c5d4802-596e-4f50-a08f-c41fb8f9fab0`) is
  schemaless — adding `title`/`description` needs **no CE migration**, just writing the fields.
- The **feed logic is triplicated** and must stay in sync: `src/lib/feed.ts` (reference impl),
  the port embedded in the `/feed/*` pipeline in `bffless/handoff.proxy-rules.json`, and the
  **live** BFFless rules. `feedRule.test.ts` already asserts reference↔pipeline parity.
- The **GET node** (`/api/node`) and **list** (`/api/nodes`) handlers build the client node via
  a hardcoded projection in a `shape` function_handler step. `title`/`description` must be added
  to those projections (and to the `register` shape) or they never reach the client / feed.
- There is a **reusable server-side ACL gate**: a `gate` function_handler exposing
  `evalAccess(chain, viewer) → none|view|edit|owner`. The **DELETE `/api/node`** handler already
  uses it to require `edit` on a *leaf* by walking its parent-folder chain. The metadata write
  copies this — **not** the current `PATCH /api/node`, which is folder + `mode` + owner-gated.
- `data_update` is a whole-record read-modify-write and clobbers concurrent same-record writes
  (apps#194). The metadata write is a single, isolated `data_update` of only the provided fields
  and is sequenced — it shares no concurrent path with other same-record writers.

## Architecture

### 1. Data model — `src/lib/nodes.ts`

Add to `HandoffNode`:

```ts
title: string | null        // display-title override; null = use filename
description: string | null  // plain-text, multi-line; null = none
```

`toNode()` coerces both: `string`-or-`null`, `title` trimmed to `null` when blank. New uploads
leave both `null` (no change to the register body).

### 2. API — extend `PATCH /api/node`

One metadata-update pipeline that branches by payload; the two branches are mutually exclusive
by node type:

- `{ id, title?, description? }` → target must be **file/site**. Permission: **`edit`** on the
  parent-folder chain, mirroring the DELETE handler's `gate` + `evalAccess`. `data_update` writes
  **only** the provided fields. An empty string clears the field back to `null`.
- `{ id, mode }` → unchanged (folder, owner/admin).

Validation: UUID `id`; at least one editable field present; `title` ≤ 200 chars, `description`
≤ 2000 chars, both coerced to string. Responses: `200 {id,title,description}` on success,
`400` invalid request, `403` forbidden (matching the existing handler's shape).

Client: an `updateNodeMeta` RTK Query mutation in `src/store/handoffApi.ts` that invalidates the
node tag and its parent listing.

### 3. Feed rendering — `src/lib/feed.ts` (+ pipeline port + live rules)

- `FeedItem` gains `title: string | null` and `description: string | null`; `selectFeedItems`
  carries them from the node.
- `renderFeedXml`:
  - `<title>` = `title || name`.
  - `<description>`: when `description` is set, emit a leading `<p>` of the escaped text
    (newlines → `<br>`), **then** the existing body unchanged (inline `<img>` + `media:content`/
    `media:thumbnail` for images; `name (size)` for other files; name for a Site). When unset,
    behavior is byte-identical to today. Images therefore keep their thumbnail *and* gain the note.
- The description text lands inside a CDATA/HTML context, so escape for that context (reuse the
  existing `htmlAttr`-style escaping) — quotes/angle-brackets/`&` encoded, then newline→`<br>`.
- Keep `feed.ts` and the embedded pipeline port behaviorally identical; extend the
  `feedRule.test.ts` parity test.

### 4. UI — editable details in the viewer (`src/pages/HandoffViewer.tsx`)

A **details block** directly under the sticky control bar:

- **Read view** (everyone, including guests via a [[Share Link]] token): render `title` as an
  `<h1>` (fallback filename) with the filename + size as a subline, and `description` below.
  Rendered only when `title` or `description` is set.
- **Writers** (the `edit`/`canShare` gate the control bar already computes): an **"Edit details"**
  affordance opening a small dialog — title `<input>` + description `<textarea>` + Save — reusing
  the existing dialog pattern (ShareDialog / delete-confirm). When nothing is set, writers see a
  slim "+ Add title & description" link; viewers with nothing set see just the filename (today's look).

Folder listings (`FolderView.tsx`) stay filename-only in v1.

### 5. Mocks + tests

- `src/mocks/handlers.ts`: store/return `title`/`description`; implement the PATCH metadata branch
  (the mock == real contract in `nodes.ts`).
- Tests:
  - `feed.test.ts` — title override; description-above-image; description on non-image; on a Site;
    empty-field fallbacks are byte-identical to current output.
  - `feedRule.test.ts` — reference↔pipeline parity with the new fields.
  - `nodes` coercion — `title`/`description` string/null/blank handling.
  - metadata-PATCH gate — viewer `403`, writer `200`, empty string clears to `null`.
  - viewer edit-dialog UI test — writer sees Edit, viewer/guest read-only, save round-trips.

### 6. Live deployment (post-merge)

The exported `handoff.proxy-rules.json` does **not** touch the live rules (Sandcastle doesn't
deploy live proxy rules). After merge, update the **live** BFFless `handoff` set via MCP — the
`/feed/*` pipeline handler and the `PATCH /api/node` handler — folding into the shared base set
and diff-verifying (prod/preview aliases share one set; MCP can't rename a set).

### 7. Docs

- `CONTEXT.md`: add **Title** and **Description** to the glossary — additive display metadata on a
  leaf, feed-surfaced; `title` falls back to the filename; `description` is plain text.
- **ADR-0009** — "Content title/description are additive, feed-surfaced metadata" — recording the
  additive-not-rename decision, plain-text choice, and leaf-only scope, matching the feed ADR trail.

## Isolation & interfaces

- `nodes.ts` / `toNode` — the single coercion seam; both new fields enter the client type here.
- `feed.ts` — pure `selectFeedItems` / `renderFeedXml`; the pipeline port is the only other copy
  and is parity-tested.
- `PATCH /api/node` handler — one server-side gate reused from DELETE; the write touches only the
  provided fields.
- The viewer details block is a self-contained component fed the resolved node + the edit gate.

## Risks

- **Triplication drift** — the live rules can silently diverge from the JSON export. Mitigated by
  the parity test + the explicit post-merge MCP sync step, and diff-verification against live.
- **`data_update` clobber** — avoided by keeping the metadata write a single isolated update of
  only the provided fields (apps#194 lesson).
- **Escaping** — description text is user-supplied and lands in an HTML/CDATA feed context; it must
  go through the existing escape path before newline→`<br>`, never raw.
