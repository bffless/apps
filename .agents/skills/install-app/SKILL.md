---
name: install-app
description: Install a bffless-apps monorepo app onto the reader's own self-hosted BFFless — import its proxy rule set, attach it to the app's alias, add required response-header rules, and verify (not provision) the external connections/secrets the app declares. Drives the existing BFFless MCP against the reader's instance; no new runtime.
---

# install-app

Automates the **backend install** step of `GETTING-STARTED.md` for one app
(`studio` or `handoff`). It drives the **existing** BFFless MCP against **your own**
BFFless project — it does not add a runtime or call the maintainers' instance. It
covers everything reachable by MCP (rule-set import, alias attach, response-header
rule) and then **verifies and reports** the manual admin-panel steps it cannot do
(external AI-provider connections). It never obtains or enters provider tokens for you.

## Prerequisite: the MCP must point at YOUR instance

This skill talks to whatever BFFless the MCP named in your runtime config is
registered against. **Register it against your own admin endpoint**, not the
maintainers' `admin.j5s.dev`:

```json
{
  "mcpServers": {
    "j5s-dev": {
      "type": "http",
      "url": "https://admin.<your-domain>/mcp",
      "headers": { "X-API-Key": "<your-api-key>" }
    }
  }
}
```

If the MCP still points at `admin.j5s.dev`, **stop** — you would be importing into the
maintainers' project. Fix `url` first. (See `GETTING-STARTED.md` step 3.)

## Inputs

- **app** — `studio` or `handoff`. Determines the paths below and the alias defaults.
- **repository** — your fork's `owner/repo` on your instance (e.g. `you/apps`), used for
  the alias calls.

Per-app facts (do not hard-code app specifics beyond this table — read the app's
`bffless/README.md` for the authoritative connection/secret list):

| app | rule-set export | default alias | response-header rule |
| --- | --- | --- | --- |
| `studio` | `apps/studio/bffless/studio.proxy-rules.json` | `studio` | COOP/COEP cross-origin isolation (see below) — **required** |
| `handoff` | `apps/handoff/bffless/handoff.proxy-rules.json` | `handoff` | none |

## What the skill does

### 1. Import the rule set

Read `apps/<app>/bffless/<app>.proxy-rules.json` (the committed export — no secrets
baked in). Recreate it in your project via the MCP:

- `create_proxy_rule_set` named `<app>` in `repository`.
- For each rule in the export, `create_proxy_rule` into that set, copying its
  `pipelineConfig` / handler `code` **verbatim** and reusing the schema IDs the export
  lists (e.g. `studio_jobs`, `studio_source`, `handoff_nodes`) — do **not** invent
  schemas. IDs are remapped on import; that is expected.

If the MCP exposes a rule-set *import* call that takes the exported JSON directly, use
it — the result must be the same set of rules attached under the `<app>` set.

### 2. Attach the rule set to the app's alias

`/api/*` only serves on aliases the rule set is attached to.

- `list_aliases(repository)` → find the `<app>` alias and its current
  `proxyRuleSetIds`.
- `update_alias(repository, alias: "<app>", proxyRuleSetIds: [...existing, <newSet>])`
  — attach **alongside** any existing sets; don't clobber them.

### 3. Create required response-header rules

Some behavior can't live in the proxy-rules JSON and is deliberately kept out of it.
For **`studio`**, its Export step assembles video with multithreaded `ffmpeg.wasm`,
which needs `SharedArrayBuffer` → the page must be cross-origin isolated. Create it once
with `create_response_header_rule`:

- **Path pattern:** `**`
- **Headers:** `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless`

`handoff` needs no response-header rule.

### 4. Verify (do NOT provision) the declared connections & secrets

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

### 5. Report

End with a clear summary of:

- what was done (rule set `<app>` created, attached to the `<app>` alias, header rule
  added if applicable);
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
- attach anything to a production alias on someone else's instance.

Those stay manual admin-panel steps the guide (`GETTING-STARTED.md`) and each app's
`bffless/README.md` spell out.
