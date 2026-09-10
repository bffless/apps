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

0. **Load the tools first.** The harness's tools are *deferred*: they are listed by name in your
   context, but their parameter schemas are not loaded until you search for them. The first call
   to an unloaded tool always fails with `'<tool>' has not been loaded yet` and a dump of the
   valid schema. This is not a real error and not a sign anything is wrong — but it costs a
   round trip each time, and in a voice session the person hears every one of them as a stumble.
   Before starting, load all five you will need: `workflow.describe`, `workflow.start`,
   `workflow.status`, `workflow.outputs`, `workflow.sign`. Do not reach for `workflow.await`;
   it is listed, but the MCP endpoint refuses it by design — a stateless POST cannot wait — and
   the refusal can reach you as a bare `MCP tool call failed`. Poll `workflow.status` instead.
1. **Describe once.** `workflow.describe { impl: "capture", workflow: "capture" }` — confirm
   `headlessSafe: true` and that `recording` is a `file` input. (Over the MCP endpoint a `file`
   input accepts an `https://` URL: the dispatched driver downloads and registers it. Pass the
   URL as a plain string, never wrapped in an object.)
2. **Start.** `workflow.start { impl: "capture", workflow: "capture", inputs: { recording: <url>, direction: <text>, language?, interval? } }`.
   The answer is `pending` with a `runId`. **Keep that id; it is the only id you use.** Never
   pick a run from `workflow.runs` by recency — two recordings run at once finish out of order.
3. **Wait for the row.** Poll `workflow.status { runId }` every 15–20 s, and let its answer —
   never your own count of polls — decide when to give up. While it says `pending` the dispatch
   is healthy: it names how long ago the id was minted (`dispatched 9s ago`), that the first row
   usually appears about 60 s in, and the instant it will stop saying pending. Keep polling at
   that pace. You have no clock between tool calls, so a dozen polls in a few seconds measure
   nothing and each one is a real request; a GitHub Actions cold start is normally around a
   minute and the endpoint stays patient for ten. Only `No such run: <id>` means the dispatched
   driver never started — most often a URL that did not answer 2xx, or one over 5 GB. Say so,
   name the URL, and stop.
4. **Follow the run.** Keep polling until `status` is `succeeded`, `failed` or `cancelled`.
   Transcription is much faster than real time: a 27-minute recording finished in under three
   minutes. Do not promise the person a wait of roughly a minute per minute of recording — that
   over-estimates by an order of magnitude and leaves you narrating a wait for something already
   done. Note that on success `workflow.status` returns a single line (`Run <id> is succeeded`),
   not a snapshot — it carries no `steps[]` and no outputs, so do not try to read the bundle out
   of it. On `failed`, report the failed step and its error from whatever the status answer
   carries; a transcript with fewer than 50 words usually means silent audio, and `language: auto`
   guessing wrong empties the word list.
5. **Fetch the bundle.** `workflow.outputs { runId }` lists the run's outputs — `words`,
   `bundle`, `manifest`, `transcript` — but only `bundle` comes back with a signable `path`. The
   other three are names, not addressable refs; you get their contents from inside the zip, so
   do not try to sign them. Exchange the bundle's `path` with `workflow.sign { runId, path }`
   for a presigned URL and fetch that. The signature is good for 3600 s, so there is no need to
   rush the fetch, but do sign after the run succeeds rather than before. Save the zip, unzip it.
6. **Read it.** `manifest.json` first (`source.name`, `direction`, `plan`, `sheets[].times`,
   `embedded`), then `transcript.md` (8-second `[m:ss]` lines, the direction quoted at the top),
   `transcript.json` for word timings. Open `sheets/*.jpg` as images; each cell is a still
   labelled with its clock, and `manifest.sheets[i].times[j]` is cell `j` (row-major) of sheet
   `i` in seconds. When `manifest.embedded` is `false` (over 150 MB of sheets) the zip lists
   sheets instead of containing them: sign each `manifest.sheets[].path` to view it.

   **Read the sheets when the talk points at the screen.** For a slide presentation, a demo, or
   any recording where the speaker says "this slide", "here's a reference sheet", "as you can see
   here", or reads nothing of a dense visual aloud, the transcript has holes exactly where the
   information is densest — the speaker's words thin out precisely because the screen is carrying
   the content. The sheets are not optional colour in that case; they are the material. Open them
   before you answer, and prefer them over inferring what a slide must have said.
7. **Report.** Give the person the run id, the recording's name and spoken duration, the word
   count and sheet count, and what the transcript says in a few sentences — then do what the
   direction asked, with the transcript and sheets as your context.

## Why the URL, and not the file

The workflow's `recording` input is bytes in the harness project's bucket. Only a File ref or a
URL can name those bytes from an MCP call; there is no way to pass a file through a tool call,
and chat attachments are not addressable by remote servers. Getting the recording to a URL is
the person's step; everything after it is yours.
