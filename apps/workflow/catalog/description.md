Workflow is a browser-driven, GitHub-Actions-inspired workflow runner that runs entirely on
your BFFless project — no separate backend to deploy or maintain.

Implementations declare workflows in YAML: jobs and steps that chain your project's
pipelines together, pause for a person where a step is interactive, and render rich custom
editors (islands) in between. The harness app installed here is generic — it owns the UI,
the runner, run history, summaries and annotations, and file storage — and carries no
workflow of its own; you publish implementations into its project and they appear in the
sidebar, ready to run.

## Highlights

- **Declarative workflows** — YAML jobs and steps over your project's pipelines, with
  expressions wiring one step's outputs into the next; matrix fan-out included.
- **Interactive steps** — form steps and custom HTML islands pause the run for review,
  edits, or approval, then resume exactly where they left off.
- **Reviewable, resumable runs** — every transition is recorded server-side, so runs are
  durable, listable, re-runnable, and attachable mid-flight from another tab.
- **Headless too** — the same run page drives unattended: a Playwright driver opens
  `?auto=1`, follows the run, and writes artifacts + an exit code CI can read.
- **Summaries and annotations** — steps report human-readable summaries, notices, and
  file outputs with built-in viewers.
- **Private by default** — the whole app sits behind your instance's sign-in; runs are
  scoped to your project.

## How it works

Workflow's frontend is a static React app; its entire backend is a BFFless proxy rule set —
pipelines for runs, files, and discovery under `/api/workflow/*`. Installing it from the
catalog deploys the frontend and attaches the rule set to a `workflow` alias in one click.
The harness discovers its serving project at runtime, so the prebuilt bundle works on any
instance. It starts empty by design: publish an implementation (the `hello` package in
`bffless/workflow-implementations` is the reference) into the project with
`bffless/publish-workflow`, and its workflows show up ready to run.
