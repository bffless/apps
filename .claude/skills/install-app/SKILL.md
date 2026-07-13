---
name: install-app
description: Install a bffless-apps monorepo app onto the reader's own self-hosted BFFless — import its proxy rule set, attach it to the app's alias, add required response-header rules, create any background pipeline schedules, and verify (not provision) the external connections/secrets the app declares. Drives the existing BFFless MCP against the reader's instance; no new runtime.
---

# install-app

Automates the **backend install** step of `GETTING-STARTED.md` for one app
(`studio`, `handoff`, or `reader`). It drives the **existing** BFFless MCP against
**your own** BFFless project — it does not add a runtime or call the maintainers'
instance. It covers everything reachable by MCP (rule-set import, alias attach,
response-header rule, background pipeline schedules) and then **verifies and reports**
the manual admin-panel steps it cannot do (external AI-provider connections, and
platform-level pieces like a private/SPA domain mapping or the auth relay). It never
obtains or enters provider tokens for you.

## Prerequisite: the MCP must point at YOUR instance

This skill talks to whatever BFFless the registered MCP server is pointed at.
**Register it against your own admin endpoint**, not the maintainers' `admin.j5s.dev`
(see the [BFFless MCP server docs](https://docs.bffless.app/features/mcp-server/)):

```bash
claude mcp add --transport http bffless https://admin.<your-domain>/mcp --header "X-API-Key: <your-api-key>"
```

If the MCP still points at `admin.j5s.dev`, **stop** — you would be importing into the
maintainers' project. Re-register it against your own domain first. (See `GETTING-STARTED.md` step 3.)

## Inputs

- **app** — `studio`, `handoff`, or `reader`. Determines the paths below and the alias
  defaults.
- **repository** — your fork's `owner/repo` on your instance (e.g. `you/apps`), used for
  the alias calls.

Per-app facts (do not hard-code app specifics beyond this table — read the app's
`bffless/README.md` for the authoritative connection/secret list):

| app | rule-set source | default alias | response-header rule | background schedules |
| --- | --- | --- | --- | --- |
| `studio` | **authored** — `apps/studio/.bffless/proxy-rules/studio/` + `.../studio-blog/`; build with `npx bffless rules build <dir> -o <file>` | `studio` | COOP/COEP cross-origin isolation (see below) — **required** | none |
| `handoff` | **authored** — `apps/handoff/.bffless/proxy-rules/handoff/` + `.../handoff-rss-feed/`; build with `npx bffless rules build <dir> -o <file>` | `handoff` | none | none |
| `reader` | **authored** — `apps/reader/.bffless/proxy-rules/reader/`; build with `npx bffless rules build <dir> -o <file>` | `reader` | none | two — `/api/refresh` every 15 min + `/api/prune` nightly 03:17 UTC (see step 4) |

> **Reader's alias attach is also done by its deploy workflow.** `deploy-reader.yml`
> passes `proxy-rule-set-name: reader`, so the first deploy attaches the set to the
> `reader` alias for you. Step 2 below is still safe to run (idempotent) and makes the
> set live before the first deploy — do it so the schedules in step 4 have rules to fire.

## What the skill does

### 1. Import the rule set

Every app authors its rules; build the JSON from the authored source (no secrets baked in):

`npx bffless rules build apps/<app>/.bffless/proxy-rules/<set> -o /tmp/<set>.proxy-rules.json`

Build **every** set the app ships — Studio has two (`studio`, `studio-blog`), Handoff has
two (`handoff`, `handoff-rss-feed`), Reader has one (`reader`).

Then recreate it in your project via the MCP:

- `create_proxy_rule_set` named `<set>` in `repository` — once per set the app ships
  (Studio: `studio` + `studio-blog`; Handoff: `handoff` + `handoff-rss-feed`).
- For each rule in the JSON, `create_proxy_rule` into that set, copying its
  `pipelineConfig` / handler `code` **verbatim** and reusing the schema IDs it lists
  (e.g. `studio_jobs`, `studio_source`, `handoff_nodes`) — do **not** invent
  schemas. IDs are remapped on import; that is expected.

If the MCP exposes a rule-set *import* call that takes the JSON directly, use it — the
result must be the same set of rules attached under the `<app>` set.

### 2. Attach the rule set(s) to the app's alias

`/api/*` only serves on aliases the rule set is attached to. Attach **every** set the app
ships — for Studio and Handoff that's two, and missing the second one leaves part of the
app 404ing (Handoff's `/feed/*`, Studio's blog endpoints).

- `list_aliases(repository)` → find the `<app>` alias and its current
  `proxyRuleSetIds`.
- `update_alias(repository, alias: "<app>", proxyRuleSetIds: [...existing, ...newSets])`
  — attach **alongside** any existing sets; don't clobber them.

### 3. Create required response-header rules

Some behavior can't live in the proxy-rules JSON and is deliberately kept out of it.
For **`studio`**, its Export step assembles video with multithreaded `ffmpeg.wasm`,
which needs `SharedArrayBuffer` → the page must be cross-origin isolated. Create it once
with `create_response_header_rule`:

- **Path pattern:** `**`
- **Headers:** `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless`

`handoff` and `reader` need no response-header rule.

### 4. Create background pipeline schedules (if the app declares any)

Some apps run pipelines on a cron cadence as a **userless system trigger** (no user
session). These are `pipeline_schedules` and the MCP **can** create them with
`create_pipeline_schedule` — so the skill does, unlike the admin-only provider tokens.

Read the app's `bffless/README.md` **"Background schedules"** section for the
authoritative list. **`studio` and `handoff` declare none.** For **`reader`**, create
both (point `targetProxyRuleId` at *your* project's imported rule IDs — the ones from
step 1, not the reference project's):

| Schedule name | `cronExpression` | Target rule (`POST`) | `timezone` |
| --- | --- | --- | --- |
| `Rivulet refresh (auto ingest)` | `*/15 * * * *` | `/api/refresh` | `UTC` |
| `Rivulet nightly prune (retention)` | `17 3 * * *` | `/api/prune` | `UTC` |

Both target rules deliberately omit the `auth_required` validator (a scheduler run has no
`context.user`); they stay protected because the `reader` alias is private (see step 5).
If the schedules already exist for this project, don't duplicate them.

### 5. Verify (do NOT provision) the declared connections & secrets

Read the app's `apps/<app>/bffless/README.md` **"Manual setup (admin panel)"** section
for the authoritative list of external connections, AI-provider tokens, and secrets.
For each:

- **External AI-provider connections** (e.g. Studio's **Replicate**, **Anthropic**) have
  **no MCP path** — they can only be set in the admin panel at **Settings → AI → AI
  Services**. The skill **cannot** set them. Check whether they appear configured and, if
  not, report them **with the link to obtain the token**.
- **Generic secrets** (e.g. Studio's `HF_TOKEN`) can be verified and, **only if the user
  supplies the value**, set via `set_secret`. Never invent, guess, or fetch a token
  value.

Studio's connection map (from `apps/studio/bffless/README.md`):

| Connection | Set via | Skill's role |
| --- | --- | --- |
| **Replicate** provider token | admin panel → Settings → AI → AI Services | verify + link ([replicate.com](https://replicate.com/account/api-tokens)) — **cannot set** |
| **Anthropic** key | admin panel → Settings → AI → AI Services | verify + link ([anthropic](https://console.anthropic.com/)) — **cannot set** |
| **`HF_TOKEN`** secret | admin panel → Secrets, or MCP `set_secret` | verify; may set **only if the user supplies the value** ([Hugging Face](https://huggingface.co/settings/tokens)) |

Handoff declares its own connections/secrets and, critically, a **storage-backend
requirement** — read its `bffless/README.md` and verify what it lists.

**Reader** declares **no AI connections, no secrets, and no storage-backend
requirement** (it stores feed/item rows in data tables). What it *does* need are two
**platform-level** pieces the skill **cannot** set via MCP — verify and report them:

- **Private + SPA domain mapping** on the `reader` alias — `isPublic: false` (every route
  is behind login) and `isSpa: true` (BrowserRouter deep links). Set on the domain
  mapping in the admin panel.
- **Auth relay** — the app reads `/_bffless/auth/session` and refreshes through the
  `/api/auth/*` reverse-proxy rule (already in the imported set). On a
  `reader.<primary-domain>` subdomain this works with no extra config; otherwise the fork
  must build with `VITE_ADMIN_URL` pointing at the admin host.

See `apps/reader/bffless/README.md` → "Manual setup (admin panel)" for the authoritative
detail.

### 6. Report

End with a clear summary of:

- what was done (rule set `<app>` created, attached to the `<app>` alias, header rule
  added if applicable, background schedules created if applicable);
- **an explicit "you still need to set these manually in the admin panel:" list** — one
  line per missing connection/secret **with its link** — whenever anything is missing.
  If nothing is missing, say so.

## Verify it routed

After attaching, a request to a backend path should be **routed** (401/302), not 404:

```
curl -s -o /dev/null -w "%{http_code}" -X GET https://<app>.<your-domain>/api/<some-path>
```

A **404** means the rule set isn't attached to the `<app>` alias (revisit step 2). A
**401/302** means it's wired.

## The manual boundary (what this skill will not do)

The skill automates only what MCP can reach. It will **not**:

- set external AI-provider connections (Replicate, Anthropic) — no MCP path; manual admin
  panel only;
- invent, obtain, or enter any provider token value;
- set a domain mapping's `isPublic` / `isSpa` flags or configure the auth relay (e.g.
  Reader's private + SPA serve URL) — verify and report these, don't set them;
- attach anything to a production alias on someone else's instance.

Those stay manual admin-panel steps the guide (`GETTING-STARTED.md`) and each app's
`bffless/README.md` spell out.
