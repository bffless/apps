# Handoff — Architecture & Design

> Source of truth for the design. Read this first, then `CONTEXT.md` (glossary) and `docs/adr/`.
> A give-away BFFless app: an internal, permissioned home for docs, prototypes, and HTML — uploaded
> without git, organized in folders, handed off to a team. Showcases the BFFless business-plan wedge
> ("the home for your AI-generated apps, internal tools, and HTML docs — with a backend and auth").

## What it is

A simple internal **file server** on BFFless. You upload content, organize it into folders, control
who sees each folder, and serve it back so HTML renders live (not just downloads). Not
version-controlled.

## Domain model (see CONTEXT.md)

- **Folder** — arbitrary-depth tree; the only browsable *branch*; the unit permissions attach to.
- **File** — a single uploaded file (PDF, image, doc, video); a self-contained *leaf*.
- **Site** — a multi-file HTML bundle stored as one opaque *leaf*; opening it renders its **Entry**
  (`index.html`) in an iframe; viewers don't browse its internals.

## Access model

- **Private by default**: a new folder is visible only to its creator + project admins until granted.
- **Grant** = Principal + level. Levels: **View**, **Edit** (grantable) and **Owner** (implicit:
  creator + project admins; controls permissions, deletes folder).
- **Principal** = a BFFless user or group (picker autocompletes the instance directory), or a
  **Share Link** (app-managed, folder-scoped token, View-only, optional expiry/revoke) for
  no-account recipients. No in-app account creation.
- **Inheritance**: a folder is **Inheriting** (default; takes parent grants, may add more) or
  **Restricted** (ignores inherited grants; Owner/admins retain access). One bit per folder; no
  negative/deny grants.
- BFFless's built-in roles are project-wide only, so this whole per-folder ACL is **app logic**.

## Serving & enforcement (see ADR-0001, ADR-0002)

- **Upload**: presigned **direct-to-bucket** `PUT`; bytes never pass through the app. A Site is
  ingested **browser-side** (folder-drop via `webkitdirectory`, or a `.zip` unzipped in the browser)
  → one `PUT` per file preserving relative paths under the Site's prefix → Entry auto-detected
  (`index.html`) or picked.
- **View (non-video)**: served **through BFFless**, same-origin — so Site relative paths and runtime
  `fetch()` just work. No signed-cookie/rewrite gymnastics.
- **View (video / audio)**: presigned `GET` straight from the bucket (native Range/seek; no backend
  streaming of large media).
- **ACL enforcement**: a Handoff **pipeline** fronts the view path — authenticates the BFFless
  session, resolves the owning Folder, evaluates the ACL (grants + group membership +
  Inheriting/Restricted + share-link). On first allowed request into a Folder it sets a **short-lived
  signed folder-scoped cookie**; subsequent asset requests validate against the cookie (fast Site
  loads). Trade-off: revocation lags by the cookie TTL — keep it short.
- **State**: the whole model (folder tree, content metadata, grants, share-links) lives in **BFFless
  data tables** via pipelines. The app has no server of its own (like Studio: `/api/*` is a BFFless
  proxy rule set, exported to `bffless/` for forkers).

## Viewer UX

- **Persistent header**: home, breadcrumb of the current path, search, Upload (only with Edit on the
  current folder), account.
- **Folder browsing** is native app UI (list/grid). The **iframe is only for opened content** — the
  control bar exists *because* the iframe captures browser-back, so app chrome outside it drives
  navigation.
- **Viewing-state control bar**: **Back** (to parent folder), item title, **Share**, **Open in new
  tab**, **Fullscreen**, **Download**; owners also get **Manage access**.
- **Preview matrix**: Site → iframe; PDF → iframe pdf viewer; image → inline; **Markdown → rendered
  GitHub-flavored HTML** (client-side, sanitized); video → `<video>` (signed URL); audio → `<audio>`
  (signed URL); everything else → "preview unavailable" + Download. All non-video/audio through
  BFFless.

## Tenancy

One Handoff deployment = one BFFless project = one organization's content under a single root tree.
The BFFless instance is the tenant boundary; no multi-org within one Handoff.

## Build sequencing

- **v1 (thin vertical slice)**: upload (Files + Sites) → folder tree → viewer (header + native
  browser + iframe) with rich preview + Markdown → serving wired (signed upload, BFFless view, video
  signed) → private by default → grant **View to individual users** → **Share Links**.
- **v1.1+**: user **groups** as principals, **Edit**-level multi-contributor uploads, **Restricted**
  folders, **search**.

## Conventions (inherited from the monorepo / Studio)

- pnpm workspace package at `apps/handoff/`, served at root, React + Vite + RTK Query + Tailwind.
- Mock-first: every `/api/*` has an MSW mock returning the same shape as the real pipeline.
- Never stream files through a pipeline; presigned direct-to-bucket for uploads (edge body cap).
- `/api/*` exported to `apps/handoff/bffless/` as a proxy rule set + README for forkers.
- Its own deploy workflow `.github/workflows/deploy-handoff.yml` using `bffless/upload-artifact`.
