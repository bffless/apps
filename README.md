# bffless-apps

A pnpm monorepo of give-away apps for the [BFFless](https://bffless.app) platform. BFFless is the
platform; each app here is a self-contained frontend you can clone and deploy on your own BFFless
project.

> **New here?** [**GETTING-STARTED.md**](GETTING-STARTED.md) walks you from forking this repo to a
> live Studio deployment that transcribes a screen recording — the thinnest complete end-to-end path.

## Apps

| App | Path | What it is |
| --- | --- | --- |
| **Studio** | [`apps/studio`](apps/studio) | Turns one long screen recording into a short video re-voiced in your own cloned voice — an AI director shortens the transcript into scenes, you build each one, then export. |
| **Handoff** | [`apps/handoff`](apps/handoff) | Internal, permissioned file server on BFFless — upload docs/prototypes/HTML, organize into folders, control who sees each, served back live. |

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

### App backends (BFFless proxy rule sets)

Apps have no server — their `/api/*` lives in a BFFless proxy rule set, exported as JSON in the app
(e.g. [`apps/studio/bffless/`](apps/studio/bffless)). Import it into your BFFless project and attach
it to the app's alias before the deployed app will work. See that folder's README for steps and
prerequisites (storage, AI tokens, secrets).
