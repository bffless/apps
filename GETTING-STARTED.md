# Getting started: deploy an app end-to-end

This is the thinnest complete path from **"I made my own copy of the repo"** to **"my app is live and I just
watched it do the thing"** — Studio transcribing a screen recording, or Handoff serving back a file I
uploaded. It assumes you already have a running self-hosted BFFless (Community Edition) instance and
admin access to it. Installing BFFless itself is out of scope.

You follow it once, linearly. No prior `bffless-apps` knowledge required. **The spine is the same for
every app** — pick your app once, and each step resolves its app-specifics from that app's own
`apps/<app>/bffless/README.md`, so the guide never has to be rewritten per app.

> **How this repo is organized.** All monorepo apps share **one** BFFless project. Third-party tokens
> (Replicate, Anthropic, `HF_TOKEN`, …) are configured **per project**, not per app — set them once
> and every app reuses them. The install unit is the whole monorepo (one fork); you then deploy
> whichever app(s) you want via each app's own workflow.

---

## Pick your app

The spine below is written with a placeholder **`<app>`**. Choose the app you're installing and read
`<app>` as that value everywhere. Every per-app fact resolves from that app's README:

| `<app>` | Per-app README (app-specifics live here) | Alias | Deploy workflow | First-success |
| --- | --- | --- | --- | --- |
| `studio` | [`apps/studio/bffless/README.md`](apps/studio/bffless/README.md) | `studio` | **Deploy Studio to BFFless** | upload a recording → see the transcript |
| `handoff` | [`apps/handoff/bffless/README.md`](apps/handoff/bffless/README.md) | `handoff` | **Deploy Handoff to BFFless** | upload a file → see it served back |
| `reader` | [`apps/reader/bffless/README.md`](apps/reader/bffless/README.md) | `reader` | **Deploy Reader to BFFless** | sign in → add a feed → see items appear |

Each app's README has a **"Manual setup (admin panel)"** section (the human-only, admin-panel steps —
external connections/AI tokens, secrets, **storage backend requirements**, response-header rules) and
a **"First-success checkpoint"** section. The spine points at those two sections instead of baking any
one app's specifics into itself.

> **This is a hard convention, enforced in CI.** Every app ships its backend as an **authored** rule
> set under `apps/<app>/.bffless/proxy-rules/<set>/` that CI syncs to the project on deploy, plus
> `apps/<app>/bffless/README.md` with those two sections — that's what lets this one guide install any
> app, including any future one, without a rewrite. The rule and its CI check are documented in
> [`docs/app-pipelines-convention.md`](docs/app-pipelines-convention.md) (run `pnpm apps:check`
> locally).

> **Apps differ in what they need beyond the rule set — and that lives in each app's README, not the
> spine.** Studio needs AI provider tokens (Replicate, Anthropic) + `HF_TOKEN`. Handoff needs no
> tokens but **requires a real bucket storage backend** (not local file storage). Reader needs neither
> tokens nor a bucket, but needs **two background pipeline schedules** (auto-refresh + nightly prune)
> and a **private, SPA domain mapping** plus the **auth relay** — the `install-app` skill creates the
> schedules and reports the rest.

---

## The spine

1. [Get your own copy: fork or template](#1-get-your-own-copy-fork-recommended-or-use-the-template)
2. [Set the deploy variables on your fork](#2-set-the-deploy-variables-on-your-fork)
3. [Register the BFFless MCP against your own instance](#3-register-the-bffless-mcp-against-your-own-instance)
4. [Provision the project in the admin panel (human-only, once)](#4-provision-the-project-in-the-admin-panel-human-only-once)
5. [Import the app's backend and attach it to the alias](#5-import-the-apps-backend-and-attach-it-to-the-alias)
6. [Deploy the app](#6-deploy-the-app)
7. [First-success checkpoint](#7-first-success-checkpoint)

---

## Variables checklist

Set these up front — later steps assume they exist. The last column says **who** sets each and
whether tooling can do it (some can only be entered by a human in the admin UI). The AI-token /
storage rows are **per-app** — the concrete list for your `<app>` lives in its README's **"Manual
setup (admin panel)"** section, so it stays correct as the app changes.

| Where | Name | Value | Purpose | Who sets it |
| --- | --- | --- | --- | --- |
| GitHub repo variable | `BFFLESS_URL` | self-hosted instance URL | CI deploy target | human (GitHub settings) |
| GitHub repo secret | `BFFLESS_API_KEY` | API key from their instance | CI deploy auth | human (GitHub settings) |
| `claude mcp add` | `url` | `https://admin.<their-domain>/mcp` | point installer at their instance | human |
| `claude mcp add` | `X-API-Key` header | their API key | MCP auth | human |
| Deploy workflow | `alias:` | `<app>` (fixed default — leave it) | must match the alias the rule set is attached to | — |
| Admin panel (per app) | AI-provider tokens / secrets / storage backend | see `apps/<app>/bffless/README.md` → **Manual setup (admin panel)** | what each app's pipelines need | **human, admin panel (some MCP-settable, provider tokens are admin-only)** |

---

## 1. Get your own copy: fork (recommended) or use the template

You need your own copy of the whole monorepo — **the install unit is one repo**, and you then deploy
whichever app(s) you want via the per-app workflows. There are two ways to make that copy; **fork is
recommended.** Either way you end up with one repo you own, and the rest of this guide is identical.

### Fork (recommended)

Fork [`bffless/apps`](https://github.com/bffless/apps) to your own account/org. A fork keeps the
**upstream link** to `bffless/apps`, so you can pull future app fixes and newly added apps with GitHub's
**Sync fork** button. That makes it the best choice for these give-away apps, which keep improving — you
stay on the receiving end of upstream updates. You deploy from your fork, so CI runs under your GitHub
settings and pushes to **your** BFFless instance.

### Use this template

`bffless/apps` is a GitHub **template repository**, so its **"Use this template"** button gives you a
clean, **unlinked** repo you own outright. Pick this when you want your own product and *won't* track
upstream. The trade-off: there's **no upstream link**, so there's **no easy Sync fork** — you'd have to
merge any upstream changes by hand.

> Later steps say "your fork" (e.g. step 2's deploy variables). If you used the template, read that as
> "your copy" — the deploy variables and workflows work the same on a template-created repo.

## 2. Set the deploy variables on your fork

In your fork's **Settings → Secrets and variables → Actions**:

- **Variable** `BFFLESS_URL` — your self-hosted instance URL.
- **Secret** `BFFLESS_API_KEY` — an API key from your instance.
- **Variable** `BFFLESS_PROJECT` — your project as `owner/name`. The committed `.bffless/config.json`
  targets the upstream demo project, so forkers must set this repo variable to their own project or
  the rules-sync/dry-run/drift-check steps will target the wrong one.

These are what each app's `deploy-<app>.yml` workflow uses to authenticate and pick its deploy target.
See the top three rows of the [variables checklist](#variables-checklist).

## 3. Register the BFFless MCP against your own instance

Register the BFFless MCP server with Claude Code, pointing it at **your** admin endpoint — **not** the
maintainers' instance. Run this from the repo root (see the
[BFFless MCP server docs](https://docs.bffless.app/features/mcp-server/) for details):

```bash
claude mcp add --transport http bffless https://admin.<your-domain>/mcp --header "X-API-Key: <your-api-key>"
```

Use `https://admin.<your-domain>/mcp` and your own API key. This is what lets Claude (via the
`install-app` skill) import proxy rules into **your** project.

## 4. Provision the project in the admin panel (human-only, once)

This step is **human-only** and **per app**. Some things an app needs — most notably **AI Services
provider tokens (Replicate, Anthropic)** — have **no API or MCP** and can *only* be entered in the
admin UI at **Settings → AI → AI Services**. Tooling (including the MCP and the `install-app` skill)
**cannot** set them. Generic secrets go under **Settings → Secrets** (the MCP `set_secret` can set
those *if you supply the value*, but the guide assumes you enter them by hand). Storage/data-table
provisioning also happens here.

Because all monorepo apps share one project, you configure these **per project, once** — not per app.

**The exact per-app list — which tokens/secrets/storage your `<app>` needs and where to create each —
lives in the app's own README, so it stays correct as the app changes:**

➡️ **`apps/<app>/bffless/README.md` → "Manual setup (admin panel)"** (open your app's README from the
[Pick your app](#pick-your-app) table).

That section enumerates, for your app: external connections / AI-provider tokens, secrets, **storage
backend requirements**, and any response-header rules. Two examples of how apps differ (don't hard-code
either here — follow the README so you always get the current one):

- **Studio** → obtain and enter a **Replicate** token, an **Anthropic** key, and the **`HF_TOKEN`**
  secret, plus a default storage bucket and the `studio_jobs`/projects data tables.
- **Handoff** → **no AI tokens or secrets**, but it **requires a real bucket storage backend (S3/GCS/
  Spaces/MinIO) — it will not work on local file storage** — plus the `handoff_nodes` /
  `handoff_share_links` data tables and the auth relay.
- **Reader** → **no AI tokens, no secrets, any storage backend** (feeds/items live in the
  `reader_feeds` / `reader_items` data tables). It needs the **auth relay**, a **private + SPA** domain
  mapping on the `reader` alias, and **two background pipeline schedules** (auto-refresh + nightly
  prune) — the `install-app` skill creates the schedules for you.

## 5. Import the app's backend and attach it to the alias

The app has no app server: its `/api/*` is a **BFFless proxy rule set**. Every app **authors** its
rules under `apps/<app>/.bffless/proxy-rules/<set>/` — `ruleset.yaml`, one file per route, and handler
bodies as real `.fn.js` files — and this repo's own deploys sync them to the `bffless/apps` project via
CI. Editing the source does nothing on its own for *your* project, though: the rules only serve once
they reach your project and are attached to the `<app>` alias.

### Recommended: run the `install-app` skill

With the MCP registered against **your** instance (step 3), run the repo-local **`install-app`** skill
for your `<app>` (`studio`, `handoff`, or `reader`). It automates everything reachable by MCP:

1. gets the rule-set JSON — building it from the authored source
   (`npx bffless rules build apps/<app>/.bffless/proxy-rules/<set> -o …`) — and imports it (creates the
   `<app>` rule set + rules; an app with two sets gets both),
2. attaches it to the **`<app>` alias** alongside any existing sets,
3. creates any required response-header rule (e.g. Studio's COOP/COEP; **Handoff and Reader need
   none**),
4. creates any background pipeline schedules the app declares (e.g. Reader's auto-refresh + nightly
   prune; **Studio and Handoff declare none**),
5. **verifies** the external connections the app declares and reports what's still missing **with
   links** — it does *not* set provider tokens or platform-level pieces like Reader's private/SPA
   domain mapping (no MCP path).

It ends with an explicit "set these manually in the admin panel: …" list when connections are missing
— those are step 4's admin-panel tokens, which no tooling can set. The skill ships in the repo
(`.claude/skills/install-app/`), so it's already on your fork.

### Fallback: do it by hand

If you'd rather not use the skill, do it manually — the full, app-specific detail (import steps,
alias, `schemaId` remapping, any response-header rule) is in your app's
`apps/<app>/bffless/README.md` (from the [Pick your app](#pick-your-app) table):

1. **Get the import JSON.** Build it from the authored source —
   `npx bffless rules build apps/<app>/.bffless/proxy-rules/<set> -o /tmp/<set>.proxy-rules.json`.
   Build **every** set the app ships: Studio has two (`studio`, `studio-blog`), Handoff has two
   (`handoff`, `handoff-rss-feed` — the app API and the public folder feeds), Reader has one (`reader`).
2. **Import** the JSON — via the dashboard (**Proxy Rules → Import**), by asking Claude with the MCP
   connected, or `npx bffless rules push apps/<app>/.bffless/proxy-rules/<set>` to push straight to
   your project and skip the manual build/import round-trip. (The repo's committed
   `.bffless/config.json` targets the upstream demo instance — point the push at your own with
   `--api-url <your-instance> --project <owner/name>` and your `BFFLESS_API_KEY`.) This creates the
   `<app>` rule set and its rules (IDs are remapped on import).
3. **Attach** the `<app>` rule set to the **`<app>` alias** (the alias your deploy uploads to).
   `/api/*` only serves on aliases the rule set is attached to.
4. **Apply any app-specific extras** the README calls out — e.g. Studio's COOP/COEP response-header
   rule (needed for `ffmpeg.wasm` threading), Handoff's `schemaId` remap to your own data tables, or
   Reader's **two pipeline schedules** (auto-refresh + prune) plus its **private + SPA** domain
   mapping. **Handoff and Reader need no response-header rule.**

## 6. Deploy the app

Run the app's deploy workflow from your fork: **Actions → "Deploy <App> to BFFless" → Run workflow**
(or push a change under `apps/<app>/**`). It builds the app and uploads the artifact to the `<app>`
alias using your `BFFLESS_URL` / `BFFLESS_API_KEY`. Leave the workflow's `alias: <app>` as-is — it must
match the alias you attached the rule set to in step 5.

## 7. First-success checkpoint

Open your deployed app (`<app>.<your-domain>`) and perform its first-success action — the concrete
end-to-end round-trip in that app's README **"First-success checkpoint"** section:

- **Studio** → **upload a short screen recording** and **see the transcript come back** (exercises
  upload, storage, and the WhisperX transcribe pipeline).
- **Handoff** → **upload a file** and **see it served back** (exercises the presigned direct-to-bucket
  upload, `handoff_nodes` registration, and the ACL-gated serve path).
- **Reader** → **sign in, add a feed URL, and hit "Refresh now"** — items should appear and open in the
  reading pane (exercises the auth relay, the `/api/feeds` upsert, and the `xml_feed_parse` ingest
  pipeline).

**If your app does the thing, it's live.** 🎉

If it doesn't, re-check step 4 (the app's admin-panel tokens/storage) and step 5 (rule set attached to
the `<app>` alias) — a 404 on `/api/*` means the rule set isn't attached. For Handoff, a
`PRESIGNED_NOT_SUPPORTED` on upload means the project is still on local file storage rather than a
bucket. For Reader, a 404 on `/api/auth/*` means the `reader` rule set isn't attached to the `reader`
alias, and an endless bounce back to login usually means the app can't reach the admin host (check the
`reader.<primary>` → `admin.<primary>` derivation or set `VITE_ADMIN_URL`). See
`apps/<app>/bffless/README.md` for the full, app-specific troubleshooting notes.
