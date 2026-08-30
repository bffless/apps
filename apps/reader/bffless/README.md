# Rivulet backend — BFFless proxy rule set

Rivulet (the RSS/Atom reader) has no app server. Its `/api/*` endpoints are a **BFFless proxy rule
set**. To run Rivulet against your own BFFless project you import that rule set and attach it to the
alias serving the app.

Rivulet's rule set is **authored** under
[`apps/reader/.bffless/proxy-rules/reader/`](../.bffless/proxy-rules/reader/) (`ruleset.yaml` + a
`rules/` file per route + schemas) — that's the source of truth, not a committed JSON export. It
contains **no secrets**.

The set holds the **SuperTokens auth reverse-proxy** (`/api/auth/*`) plus the reading pipelines
(15 rules total, `order` 0–14):

| Path | Method | Pipeline |
| --- | --- | --- |
| `/api/feeds` | `GET` | list subscribed feeds |
| `/api/feeds` | `POST` | add a feed by URL (`data_upsert_many`, dedup by `scopedUrl`) |
| `/api/feeds/remove` | `POST` | unsubscribe (delete the feed row + cascade-delete its non-starred items) |
| `/api/feeds/folder` | `POST` | move a feed between folders (`data_update`; the insert-only add endpoint can't, #133) |
| `/api/items` | `GET` | query stored items, optionally `?feedId=<url>` |
| `/api/items/read` | `POST` | set an item's `read` flag (`data_update` by `guid`, #114) |
| `/api/items/read-all` | `POST` | mark all read for a view (`all`/`river`/`starred`/feed/folder), `data_update` where `read=false` |
| `/api/items/star` | `POST` | set an item's `starred` flag (`data_update` by `guid`; starred items are prune-exempt, #115) |
| `/api/items/archive` | `POST` | set an item's `archived` flag by `guid`; archived items are hidden from views and prune-exempt |
| `/api/items/delete` | `POST` | hard-delete an item by `guid` (`data_delete`); a still-in-feed item may re-insert on the next refresh |
| `/api/counts` | `GET` | sidebar badge counts: unread-per-feed + starred total (`db_aggregate`) |
| `/api/refresh` | `POST` | ingest: `data_query → xml_feed_parse → data_upsert_many` (dedup by `scopedGuid`); stamps a numeric epoch-ms `fetchedAt` and defaults `read`/`starred` to `false` |
| `/api/discover` | `POST` | auto-discovery (#113): `http_request` fetches a site/feed URL server-side so the browser can `DOMParser` it for `<link rel="alternate">` feed links |
| `/api/prune` | `POST` | retention (#119): `data_delete` delete-by-query removes `read` + un`starred` items older than 30 days (`fetchedAt < now-30d`); starred + unread are exempt |

Most `/api/*` pipelines carry an `auth_required` validator. The two **schedule-fired** pipelines —
`/api/refresh` and `/api/prune` — deliberately **omit** it: the CE scheduler triggers them as a
*userless* system run, and `auth_required` (which requires `context.user`) would reject that. They stay
protected because the reader alias is **private** (edge-gated login), so anonymous HTTP to any route —
including `/api/*` — is bounced to login before it reaches the pipeline; the scheduler bypasses that
edge and runs the pipeline directly. All pipelines reference two data-table schemas, `reader_feeds` and
`reader_items` (see **Data tables** below). Two **`pipeline_schedules`** (#119) fire `/api/refresh`
every 15 minutes and `/api/prune` nightly at 03:17 UTC, both as system context (no user session) —
see **Background schedules** below.

## Import

On this repo's own deploys, CI syncs the authored set straight to the `bffless/apps` project via
`bffless/deploy-proxy-rules` — nothing to import by hand. Check for local drift any time with
`npx bffless rules diff`.

**Installing into your own project** (your fork's CI isn't wired to your instance yet, or you're doing
a one-off import): build the import JSON from the authored source, then import it same as any exported
rule set:

```bash
npx bffless rules build apps/reader/.bffless/proxy-rules/reader -o /tmp/reader.proxy-rules.json
```

**Dashboard:** BFFless project → Proxy Rules → **Import** → upload the built JSON.

**CLI:** `npx bffless rules push apps/reader/.bffless/proxy-rules/reader` pushes straight to your
project, skipping the manual build/import round-trip. (The repo's committed `.bffless/config.json`
targets the upstream demo instance — point the push at your own with `--api-url <your-instance>
--project <owner/name>` and your `BFFLESS_API_KEY`.)

**Claude / MCP:** ask Claude (with the BFFless MCP connected) to import the built JSON into your
project. It creates the `reader` rule set and its rules (IDs are remapped on import).

After import, **attach the `reader` rule set to the alias** your deploy uploads to (e.g. the `reader`
alias / `reader.<your-domain>`). `/api/*` only serves on aliases the rule set is attached to.

## Manual setup (admin panel)

Everything the human must configure in the BFFless admin panel that the `install-app` skill
**cannot** do. Do these once in the target project.

- **External connections / AI provider tokens — none.** Rivulet has no AI handlers at this stage, so
  it needs **no** Replicate / Anthropic / other provider tokens.
- **Secrets — none app-specific.** Rivulet's rules reference no named `secrets.*`.
- **Storage backend — none required.** Rivulet stores feed/item rows in data tables, not the object
  store, so it works on any storage backend (including local file storage).
- **Data tables** — the pipelines reference the `reader_feeds` and `reader_items` schemas. On import
  into a fresh project these are created for you (or create them to match the **Data tables** section
  below); the exported rule set's `schemaId`s are for the reference project and are remapped on
  import.
- **Response-header rules — none on a clean project.** Rivulet needs no extra headers by itself.
  **Exception — inline post bodies:** Rivulet renders a Handoff markdown post's body inline by
  iframing the Handoff viewer's chromeless `?embed=1` mode. If your project applies a
  cross-origin-isolation policy (`COOP`/`COEP`) — e.g. because another app on the same project uses
  `SharedArrayBuffer` (ffmpeg, etc.) — the browser blocks that iframe with
  `COEP-framed resource needs COEP header`. Fix: add a response-header rule matching the reader's
  files (`apps/reader/**`) with `Cross-Origin-Opener-Policy: unsafe-none` +
  `Cross-Origin-Embedder-Policy: unsafe-none` and a priority **below** the isolating rule, so the
  reader isn't cross-origin-isolated and can embed the viewer. (Rivulet itself doesn't use
  `SharedArrayBuffer`.) Also ensure the Handoff instance allows your reader's origin to frame it —
  same-registrable-domain subdomains are allowed automatically; a different domain needs the reader
  origin in Handoff's frame-ancestors. A fresh project with no isolation policy needs nothing here.
- **Auth relay** — the platform-level piece the gate depends on; see §1 below.
- **Serve URL — domain mapping (private, SPA)** — see §2 below.

- **Background schedules** — two `pipeline_schedules` (#119) drive the reader unattended; see
  **Background schedules** below. The `install-app` skill creates them for you (via the MCP
  `create_pipeline_schedule`); if you install by hand, add them once per project after importing the
  rule set.

## Background schedules

Rivulet's "already there when you arrive" magic is background auto-refresh, plus 30-day retention so
the item table doesn't grow forever. Both are `pipeline_schedules` (CE `pipeline_schedules` primitive)
that fire a pipeline-type proxy rule on a cron cadence **as system context** (no user session), so
feeds stay fresh and old items get pruned even with the app closed.

Create both against your project (IDs are your project's, not the reference project's):

| Schedule | Cron (UTC) | Target rule | Effect |
| --- | --- | --- | --- |
| Rivulet refresh (auto ingest) | `*/15 * * * *` | `POST /api/refresh` | pre-fetches every feed every 15 min |
| Rivulet nightly prune (retention) | `17 3 * * *` | `POST /api/prune` | deletes read + unstarred items older than 30 days |

**Claude / MCP:** the `install-app` skill does this for you; or ask Claude (BFFless MCP connected) to
`create_pipeline_schedule` for each, pointing `targetProxyRuleId` at your project's `/api/refresh` and
`/api/prune` rule IDs.

**REST:** `POST /api/pipeline-schedules/projects/:projectId/schedules` with
`{ targetProxyRuleId, cronExpression, timezone: "UTC", enabled: true }` (repo-scoped API key; gated on
bffless/ce#411). Note the path is **`/api/pipeline-schedules/projects/:id/schedules`**, *not*
`/api/projects/:id/pipeline-schedules` (which collides with the projects catch-all and returns a
misleading `400 "Project not found"` — see CONTEXT.md).

Both target rules **omit** the `auth_required` validator on purpose: CE fires a schedule as a
*userless* system run, and `auth_required` needs `context.user`, so a gated pipeline fails with
`"Authentication required to access this pipeline"` (`allowApiKey` only helps a *keyed HTTP request*,
not a scheduler run). The endpoints stay protected by the **private alias** (anonymous HTTP is
edge-bounced to login); the scheduler bypasses the edge and runs the pipeline directly. The prune's
date filter relies on `fetchedAt` being a **numeric epoch-ms** (see **Data tables**) — `data_delete`
range operators cast the field to numeric (bffless/ce#412), which an ISO string can't satisfy.

## Data tables

Two schemas back the reader (content is stored **raw** and sanitized at render — CONTEXT.md D10):

- **`reader_feeds`** — `userId` (owner), `scopedUrl` (dedup key, `userId::url`), `url`, `title`,
  `siteUrl`, `folder` (nullable), `iconUrl`, `lastFetchedAt`, `lastError`, `addedAt`.
- **`reader_items`** — `userId` (owner), `scopedGuid` (dedup key, `userId::guid`), `guid` (the feed's
  own guid), `feedId` (the owning feed's `url`, = `xml_feed_parse` `entry.source`), `title`, `link`,
  `author`, `publishedAt` (feed timestamp, ISO string), `summary`, `content`, `enclosureType` /
  `enclosureUrl`, `read`, `starred`, `archived`, `fetchedAt` (numeric epoch-ms).

**`schemaId` portability caveat:** the exported rules embed the reference project's `schemaId`s. When
you import into a different project, re-point each pipeline's `schemaId` to your project's
`reader_feeds` / `reader_items` schema IDs (same as Handoff's caveat).

### Multi-user

Rivulet is multi-user: every row carries the owning `userId`, and every data-access step in the rule
set filters on `user.id`. Two exceptions run as *userless* system context, fired by a
`pipeline_schedule`:

- `/api/refresh` step `feeds` reads **every** user's feeds — the cron ingests on everyone's behalf.
  `enrich.fn.js` then fans each parsed entry out to one row per subscriber of that feed URL, so a feed
  shared by N users is fetched once and stored N times.
- `/api/prune` step `del` filters each row's own `read` / `starred` / `archived` / `fetchedAt`, which
  is already correct per-user.

Dedup is per-user by construction: `data_upsert_many` dedups on a single column, so the synthetic
`scopedUrl` / `scopedGuid` columns carry `userId::<natural key>`. Without them the second user to
subscribe to a shared feed would have their whole ingest skipped as duplicate.

Access is gated at the alias: `requiredRole: guest` on the `reader` and `reader-preview` aliases means
a user must be signed in **and** explicitly added to the project, while CE keeps `guest` memberships
out of the admin backend.

`apps/reader/src/lib/scoping.test.ts` is the guard — it walks every rule and fails if any data-access
step loses its `userId` filter, or if a multi-filter step forgets `filterLogic: and`.

### 1. Auth relay

Rivulet uses BFFless cookie-based sessions for access control. The app reads
`/_bffless/auth/session` to detect the current user and redirects unauthenticated visitors to the
admin login relay. The session is refreshed through the `/api/auth/*` **reverse-proxy rule** in this
set (not the `/_bffless/auth` relay, which is reserved for cross-origin custom domains — see
`apps/reader/CONTEXT.md` decision **D11**).

When Rivulet is served at `reader.<your-primary-domain>` (a subdomain of the primary domain), the
SuperTokens session cookie is shared on `.<your-primary-domain>` and this works with **no extra
configuration**. The app derives the admin host from its own hostname
(`reader.<primary>` → `admin.<primary>`), so **no code edit is needed on a fork**. If you serve
Rivulet somewhere that isn't `<app>.<primary-domain>` (or for local dev), set **`VITE_ADMIN_URL`**
(e.g. `https://admin.example.com`) at build time to point at your admin host explicitly.

The same derivation gates **inline embeds**. Rivulet iframes a Handoff post or site only when the
item's `link` is an `https` origin on a subdomain of the reader's primary domain
(`reader.<primary>` → trusts `<any-label>.<primary>`, so `handoff.<primary>` works whatever label
you installed Handoff under; the apex and plain `http` are never trusted). On the enterprise
platform, where apps live at `<app>.<workspace>.workspace.<primary>`, the derived primary is
`<workspace>.workspace.<primary>`, so the rule trusts that workspace's own Handoff and excludes
sibling workspaces. If Handoff is on a **different domain** (or for local dev, where `localhost`
has no primary domain and nothing embeds), set **`VITE_TRUSTED_EMBED_ORIGINS`** at build time to a
comma-separated list of exact origins (e.g. `https://handoff.other.tld,https://docs.custom.tld`);
when set it **replaces** the same-site rule rather than extending it. Every embed is still behind
the per-host consent gate in the reading pane.

The `/api/auth/*` rule targets the CE backend's SuperTokens endpoints (`http://localhost:3000/api/auth`
in the reference deploy) with `forwardCookies: true`, so the path-scoped `sRefreshToken` cookie
reaches the backend and the rotated `Set-Cookie` headers relay back.

### 2. Serve URL — domain mapping (private + SPA)

The `reader` alias must be served at a URL, and two settings on that domain mapping matter:

- **`isPublic: false` (private).** All routes are edge-gated behind login; users must be signed in and
  explicitly added to the project to access any surface (`requiredRole: guest` on the aliases).
  Unlike Handoff, there are no anonymous share-link pages to keep public in v1.
- **`isSpa: true`.** Rivulet is a `BrowserRouter` SPA, so deep links and hard refreshes need the
  index.html fallback.
- **Build path.** The deploy uploads `apps/reader/dist`, so set the mapping's `path` to
  `/apps/reader/dist` (or rely on the auto-alias base-path) so index.html resolves at the root.

## First-success checkpoint

Once the `reader` rule set is imported and attached to the `reader` alias, the auth relay is
configured, and Rivulet is deployed (see the repo-root
[`GETTING-STARTED.md`](../../../GETTING-STARTED.md)), confirm the install with one end-to-end action:

**Sign in → reach the app shell.**

Open your deployed Rivulet (`reader.<your-domain>`). An unauthenticated visitor should see the **Sign
in** prompt; signing in should bounce through `admin.<your-domain>/login` and land you back on the
reader shell (feed sidebar + reading pane). That round-trip exercises the session read
(`/_bffless/auth/session`) and the `/api/auth/*` reverse-proxy refresh path end to end. Then **add a
feed URL and hit “Refresh now”** — items should appear and open in the reading pane. If both work,
Rivulet's core reading path is live.

- A **404 on `/api/auth/*`** means the `reader` rule set isn't attached to the `reader` alias.
- Bouncing endlessly to login (never settling on the shell) usually means the app can't reach the
  admin host — confirm `VITE_ADMIN_URL` (or the `reader.<primary>` → `admin.<primary>` derivation) is
  correct for your topology.

## Notes

- Edit the rule files under [`apps/reader/.bffless/proxy-rules/reader/`](../.bffless/proxy-rules/reader/)
  directly and commit — CI syncs the change to the project on deploy (`bffless/deploy-proxy-rules`);
  check for drift with `npx bffless rules diff`. When you add or remove endpoints, also update the
  endpoint table at the top of this README and the **Data tables** section so they stay in sync with
  the authored source.

## Posts won't render inline

Rivulet shows a Handoff markdown post's body inline by iframing the Handoff
viewer's chromeless `?embed=1` mode. If this project applies a
cross-origin-isolation policy (COOP/COEP) somewhere else — another app using
`SharedArrayBuffer`, say — that iframe is blocked.

Fix: add a response-header rule matching the reader's files (`apps/reader/**`)
with `Cross-Origin-Opener-Policy: unsafe-none` and
`Cross-Origin-Embedder-Policy: unsafe-none`, at a priority below the isolating
rule, and make sure the Handoff instance allows the reader's origin to frame
it. A fresh project with no isolation policy needs none of this.
