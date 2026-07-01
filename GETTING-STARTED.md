# Getting started: deploy Studio end-to-end

This is the thinnest complete path from **"I forked the repo"** to **"Studio is live and I just
watched it transcribe a screen recording."** It assumes you already have a running self-hosted
BFFless (Community Edition) instance and admin access to it. Installing BFFless itself is out of
scope.

You follow it once, linearly. No prior `bffless-apps` knowledge required.

> **How this repo is organized.** All monorepo apps share **one** BFFless project. Third-party
> tokens (Replicate, Anthropic, `HF_TOKEN`, …) are configured **per project**, not per app — set
> them once and every app reuses them. The install unit is the whole monorepo (one fork); you then
> deploy whichever app(s) you want via each app's own workflow.

---

## The spine

1. [Fork the repo](#1-fork-the-repo)
2. [Set the deploy variables on your fork](#2-set-the-deploy-variables-on-your-fork)
3. [Register the BFFless MCP against your own instance](#3-register-the-bffless-mcp-against-your-own-instance)
4. [Provision the project in the admin panel (human-only, once)](#4-provision-the-project-in-the-admin-panel-human-only-once)
5. [Import Studio's backend and attach it to the alias](#5-import-studios-backend-and-attach-it-to-the-alias)
6. [Deploy Studio](#6-deploy-studio)
7. [First-success checkpoint](#7-first-success-checkpoint)

---

## Variables checklist

Set these up front — later steps assume they exist. The last column says **who** sets each and
whether tooling can do it (some can only be entered by a human in the admin UI).

| Where | Name | Value | Purpose | Who sets it |
| --- | --- | --- | --- | --- |
| GitHub repo variable | `BFFLESS_URL` | self-hosted instance URL | CI deploy target | human (GitHub settings) |
| GitHub repo secret | `BFFLESS_API_KEY` | API key from their instance | CI deploy auth | human (GitHub settings) |
| Local `.mcp.json` | `url` | `https://admin.<their-domain>/mcp` | point installer at their instance | human |
| Local `.mcp.json` | `X-API-Key` | their API key | MCP auth | human |
| Deploy workflow | `alias:` | `studio` (fixed default — leave it) | must match the alias the rule set is attached to | — |
| Admin panel → AI Services | Replicate token, Anthropic key | tokens from replicate.com / anthropic | AI handlers the pipelines call | **human, admin panel only (no MCP)** |
| Admin panel → Secrets | `HF_TOKEN` (+ any others per app) | token from huggingface | referenced as `secrets.HF_TOKEN` | human (admin panel; MCP `set_secret` can set if value supplied) |

---

## 1. Fork the repo

Fork [`bffless/apps`](https://github.com/bffless/apps) to your own account/org. You deploy from your
fork, so CI runs under your GitHub settings and pushes to **your** BFFless instance.

## 2. Set the deploy variables on your fork

In your fork's **Settings → Secrets and variables → Actions**:

- **Variable** `BFFLESS_URL` — your self-hosted instance URL.
- **Secret** `BFFLESS_API_KEY` — an API key from your instance.

These are what the `deploy-studio.yml` workflow uses to authenticate and pick its deploy target. See
the top three rows of the [variables checklist](#variables-checklist).

## 3. Register the BFFless MCP against your own instance

Point your local `.mcp.json` at **your** admin endpoint — **not** the maintainers' instance:

```json
{
  "mcpServers": {
    "j5s-dev": {
      "type": "http",
      "url": "https://admin.<their-domain>/mcp",
      "headers": { "X-API-Key": "<your-api-key>" }
    }
  }
}
```

Use `https://admin.<your-domain>/mcp` and your own API key. This is what lets Claude (or the future
`install-app` skill) import proxy rules into **your** project.

## 4. Provision the project in the admin panel (human-only, once)

This step is **human-only**. Studio's pipelines call third-party AI services, and **the AI Services
provider tokens (Replicate, Anthropic) have no API or MCP** — they can *only* be entered in the
admin UI at **Settings → AI → AI Services**. Tooling (including the MCP and any install skill)
**cannot** set them. Generic secrets like `HF_TOKEN` go under **Settings → Secrets** (the MCP
`set_secret` can set those *if you supply the value*, but the guide assumes you enter them by hand).

Because all monorepo apps share one project, you configure these **per project, once** — not per
app.

**The exact per-app list — which tokens Studio needs and where to create each — lives in the app's
own README, so it stays correct as the app changes:**

➡️ **[`apps/studio/bffless/README.md`](apps/studio/bffless/README.md) → "Prerequisites (provision
these in the target project first)".**

For Studio, that section tells you to obtain and enter, in the admin panel:

- a **Replicate** token (from [replicate.com](https://replicate.com/account/api-tokens)),
- an **Anthropic** key,
- the **`HF_TOKEN`** secret (from [Hugging Face](https://huggingface.co/settings/tokens)),

plus the storage-backend and data-table requirements. Don't hard-code the list here — follow the
README so you always get the current one.

## 5. Import Studio's backend and attach it to the alias

Studio has no app server: its `/api/*` is a **BFFless proxy rule set** exported to
[`apps/studio/bffless/studio.proxy-rules.json`](apps/studio/bffless/studio.proxy-rules.json). Editing
that file does nothing on its own — the rules only serve once they're imported into your project and
attached to the alias.

Do these three things (full detail in
[`apps/studio/bffless/README.md`](apps/studio/bffless/README.md)):

1. **Import** `apps/studio/bffless/studio.proxy-rules.json` — via the dashboard
   (**Proxy Rules → Import**) or by asking Claude with the MCP connected. This creates the `studio`
   rule set and its rules (IDs are remapped on import).
2. **Attach** the `studio` rule set to the **`studio` alias** (the alias your deploy uploads to).
   `/api/*` only serves on aliases the rule set is attached to.
3. **Add the COOP/COEP response-header rule.** Studio's **Export** step assembles video with
   multithreaded `ffmpeg.wasm`, which needs `SharedArrayBuffer` — so the page must be cross-origin
   isolated. This comes from a **response-header rule** that is deliberately **not** in
   `studio.proxy-rules.json`. Add it once (Settings → Response Headers, or MCP
   `create_response_header_rule`):
   - **Path pattern:** `**`
   - **Headers:** `Cross-Origin-Opener-Policy: same-origin` and
     `Cross-Origin-Embedder-Policy: credentialless`

## 6. Deploy Studio

Run Studio's deploy workflow from your fork: **Actions → "Deploy Studio to BFFless" → Run workflow**
(or push a change under `apps/studio/**`). It builds Studio and uploads the artifact to the `studio`
alias using your `BFFLESS_URL` / `BFFLESS_API_KEY`. Leave the workflow's `alias: studio` as-is — it
must match the alias you attached the rule set to in step 5.

## 7. First-success checkpoint

Open your deployed Studio (`studio.<your-domain>`) and **upload a short screen recording**. Within a
few moments you should **see the transcript come back** — that round-trip exercises the upload,
storage, and the WhisperX transcribe pipeline end-to-end.

**If you see the transcript, Studio is live.** 🎉

If it doesn't come back, re-check step 4 (Replicate token + `HF_TOKEN`) and step 5 (rule set attached
to the `studio` alias) — a 404 on `/api/*` means the rule set isn't attached; a transcribe failure
usually means a missing provider token. See `apps/studio/bffless/README.md` for the full
troubleshooting notes.
