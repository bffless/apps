---
name: capture-recording
description: Turn a screen recording at a URL into a Capture bundle (transcript with word timings, contact sheets, manifest) by starting and following a run of the Workflow harness's capture/capture workflow over its MCP connector — start to unzipped zip, no person in the loop
---

# Capture a recording

You are connected to a BFFless Workflow harness (e.g. `workflow.bffless.dev`) over MCP, which
exposes `workflow.list`, `workflow.describe`, `workflow.start`, `workflow.status`,
`workflow.outputs`, `workflow.sign` (and a few more). The person gives you a **URL to a video**
and a **direction** — what they want a later session to do with the recording. You run the
`capture` implementation's `capture` workflow and hand back the bundle's contents.

## Inputs

- `recording` — the video's `https://` URL. Public, or a signed/share link that fetches without
  cookies (a Handoff `/api/uploads/content/...` or `/r/<id>/<name>?token=` link, a presigned
  bucket URL). Not a file: attachments are never reachable by the harness, and video cannot be
  attached to a chat at all. If the person has only a file, ask them to put it somewhere with a
  URL (Handoff's drag-and-drop) and paste the link.
- `direction` — their words, verbatim. Carried into the bundle for the session that reads it.
- Optional: `language` (default `en`; pick it rather than `auto` — a wrong guess loses every
  word timing), `interval` (seconds between stills, default 5).

## Steps

1. **Describe once.** `workflow.describe { impl: "capture", workflow: "capture" }` — confirm
   `headlessSafe: true` and that `recording` is a `file` input. (Over the MCP endpoint a `file`
   input accepts an `https://` URL: the dispatched driver downloads and registers it.)
2. **Start.** `workflow.start { impl: "capture", workflow: "capture", inputs: { recording: <url>, direction: <text>, language?, interval? } }`.
   The answer is `pending` with a `runId`. **Keep that id; it is the only id you use.** Never
   pick a run from `workflow.runs` by recency — two recordings run at once finish out of order.
3. **Wait for the row.** Poll `workflow.status { runId }` every 15–20 s. For the first ~2 minutes
   "no such run" is normal (a GitHub Actions cold start). If there is still no row after ~5
   minutes, the dispatched driver refused the start — most often a URL that did not answer 2xx,
   or one over 5 GB. Say so, name the URL, and stop.
4. **Follow the run.** Keep polling until `status` is `succeeded`, `failed` or `cancelled`. A
   4-minute recording takes 2–3 minutes; budget ~1 minute per minute of recording. On `failed`,
   report the failed step from the snapshot (`steps[*].status`, its `error`) — a transcript with
   fewer than 50 words usually means silent audio; `language: auto` guessing wrong empties the
   word list.
5. **Fetch the bundle.** `workflow.outputs { runId }` → `outputs.bundle` is a File ref
   `{ path, name, contentType, size, url }`. Its `url` is session-only; exchange `path` with
   `workflow.sign { runId, path }` for a presigned URL and fetch that (it expires in minutes —
   sign right before fetching). Save the zip, unzip it.
6. **Read it.** `manifest.json` first (`source.name`, `direction`, `plan`, `sheets[].times`,
   `embedded`), then `transcript.md` (8-second `[m:ss]` lines, the direction quoted at the top),
   `transcript.json` for word timings. Open `sheets/*.jpg` as images; each cell is a still
   labelled with its clock, and `manifest.sheets[i].times[j]` is cell `j` (row-major) of sheet
   `i` in seconds. When `manifest.embedded` is `false` (over 150 MB of sheets) the zip lists
   sheets instead of containing them: sign each `manifest.sheets[].path` to view it.
7. **Report.** Give the person the run id, the recording's name and spoken duration, the word
   count and sheet count, and what the transcript says in a few sentences — then do what the
   direction asked, with the transcript and sheets as your context.

## Why the URL, and not the file

The workflow's `recording` input is bytes in the harness project's bucket. Only a File ref or a
URL can name those bytes from an MCP call; there is no way to pass a file through a tool call,
and chat attachments are not addressable by remote servers. Getting the recording to a URL is
the person's step; everything after it is yours.
