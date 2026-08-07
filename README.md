# bffless-apps

A pnpm monorepo of give-away apps for the [BFFless](https://bffless.app) platform. BFFless is the
platform; each app here is a self-contained frontend you can clone and deploy on your own BFFless
project.

> **New here?** [**GETTING-STARTED.md**](GETTING-STARTED.md) walks you from forking this repo to a
> live deployment of the app of your choice — Studio transcribing a screen recording, or Handoff
> serving back a file — via one app-agnostic spine. The thinnest complete end-to-end path.

## Agent skills

This repo publishes agent skills for the apps as the `bffless-apps` collection
(currently: `handoff-api` — drive a Handoff deployment's API as an agent).
Install into your own project either way:

    npx skills add bffless/apps --skill handoff-api   # skills CLI (any harness)

(plain `npx skills add bffless/apps` installs every skill in this repo,
including the repo-private `install-app` skill, which isn't meant for
consumers — scope the install with `--skill handoff-api`)

or in Claude Code, add this repo as a plugin marketplace and install the
`bffless-apps` plugin:

    /plugin marketplace add bffless/apps
    /plugin install bffless-apps@bffless-apps-plugins

Canonical skill sources live under `plugins/bffless-apps/skills/`; the skills
CLI serves consumers from the generated `.agents/skills/` mirror
(`pnpm skills:sync`). Only *published* skills (currently `handoff-api`) get
mirrored into both `.claude/skills/` and `.agents/skills/` this way —
authored, repo-private skills like `install-app` stay canonical in
`.claude/skills/` and are mirrored only into `.agents/skills/`.

## Apps

| App | Path | What it is |
| --- | --- | --- |
| **Studio** | [`apps/studio`](apps/studio) | Turns one long screen recording into a short video re-voiced in your own cloned voice — an AI director shortens the transcript into scenes, you build each one, then export. |
| **Handoff** | [`apps/handoff`](apps/handoff) | Internal, permissioned file server on BFFless — upload docs/prototypes/HTML, organize into folders, control who sees each, served back live. |
| **Reader** | [`apps/reader`](apps/reader) | Rivulet — a self-hostable, Google Reader–style RSS/Atom reader. Personal and private behind real auth: subscribe to feeds, have them auto-refreshed in the background, and read them in a fast keyboard-driven river with folders, star-to-keep, and OPML import/export. |

## Develop

```bash
pnpm install            # one install for the whole workspace
pnpm studio:dev         # run an app (alias for: pnpm --filter studio dev)
pnpm studio:build       # type-check + build
pnpm studio:test        # unit tests (Vitest)
pnpm studio:lint
```

Per-app commands also work directly: `pnpm --filter <app> <script>`.

## Deploy a single app

Each app deploys independently to BFFless via its own GitHub Action
(`.github/workflows/deploy-<app>.yml`), which builds that app and runs
[`bffless/upload-artifact`](https://github.com/bffless/upload-artifact). Triggers on a push that
touches the app's path, or manually via **Run workflow** (`workflow_dispatch`).

To deploy from your own fork, set repo-level `BFFLESS_URL` (variable) and `BFFLESS_API_KEY`
(secret), then run the app's workflow.

**Handoff is the exception.** It is no longer deployed from this repo — it's installed from the
BFFless app catalog (1-click), and CI here only builds and releases its install bundle. Its deploy
workflow ships as a template at [`apps/handoff/bffless/deploy-handoff.yml`](apps/handoff/bffless/deploy-handoff.yml);
copy it into `.github/workflows/` in your fork to take over deploys yourself.

### App backends (BFFless proxy rule sets)

Apps have no server — their `/api/*` lives in a BFFless proxy rule set, exported as JSON in the app
(e.g. [`apps/studio/bffless/`](apps/studio/bffless)). Import it into your BFFless project and attach
it to the app's alias before the deployed app will work. See that folder's README for steps and
prerequisites (storage, AI tokens, secrets).
