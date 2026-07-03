# Rivulet backend — BFFless proxy rule set

Rivulet (the RSS/Atom reader) has no app server. Its `/api/*` endpoints are a **BFFless proxy rule
set**. To run Rivulet against your own BFFless project you import that rule set and attach it to the
alias serving the app.

[`reader.proxy-rules.json`](reader.proxy-rules.json) is the exported rule set (format
`bffless-proxy-rule-set` v2). It contains **no secrets**.

At this scaffold stage (bffless/apps#111) the set holds a single rule — the **SuperTokens auth
reverse-proxy** (`/api/auth/*`). The feed/item/refresh pipelines and their data-table schemas land
with the later stories (#112+), which will grow this file as they go.

## Import

**Dashboard:** BFFless project → Proxy Rules → **Import** → upload `reader.proxy-rules.json`.

**Claude / MCP:** ask Claude (with the BFFless MCP connected) to import
`apps/reader/bffless/reader.proxy-rules.json` into your project. It creates the `reader` rule set and
its rules (IDs are remapped on import).

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
- **Response-header rules — none.** Rivulet needs no extra response headers.
- **Auth relay** — the platform-level piece the gate depends on; see §1 below.
- **Serve URL — domain mapping (private, SPA)** — see §2 below.

Later stories add their own manual steps here (data tables for `feeds` / `items`, and the two
`pipeline_schedules` for background refresh + retention).

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

The `/api/auth/*` rule targets the CE backend's SuperTokens endpoints (`http://localhost:3000/api/auth`
in the reference deploy) with `forwardCookies: true`, so the path-scoped `sRefreshToken` cookie
reaches the backend and the rotated `Set-Cookie` headers relay back.

### 2. Serve URL — domain mapping (private + SPA)

The `reader` alias must be served at a URL, and two settings on that domain mapping matter:

- **`isPublic: false` (private).** Rivulet is a **personal, single-user-per-deploy** reader with no
  public surface in v1 — every route is behind login. Unlike Handoff, there are no anonymous
  share-link pages to keep public.
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
(empty) app shell. That round-trip exercises the session read (`/_bffless/auth/session`) and the
`/api/auth/*` reverse-proxy refresh path end to end. If you reach the shell as a signed-in user,
Rivulet's auth spine is live.

- A **404 on `/api/auth/*`** means the `reader` rule set isn't attached to the `reader` alias.
- Bouncing endlessly to login (never settling on the shell) usually means the app can't reach the
  admin host — confirm `VITE_ADMIN_URL` (or the `reader.<primary>` → `admin.<primary>` derivation) is
  correct for your topology.

## Notes

- Re-export from the BFFless dashboard (Proxy Rules → Export) after changing rules, and commit the
  updated JSON here so the giveaway stays current.
- Later stories (#112+) add feed/item/refresh rules and their `schemaId` references. Once those
  exist, this README will grow a **data tables** section and a **schemaId portability caveat** like
  Handoff's.
