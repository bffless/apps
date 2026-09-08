# Workflow: URL values for `file` inputs over the MCP endpoint — a Claude session runs Capture start to zip

**Date:** 2026-09-08 · **Packages:** `packages/workflow-headless`, `packages/workflow-agent-tools`, `apps/workflow` (tool text only) · **Related:** spec 07 (headless), spec 10 (agent embedding), ADR-0006 (driven runs), `workflow-implementations/workflows/capture`
**Status:** design approved in conversation; awaiting spec review, then an implementation plan.

## Context

The `capture` implementation on `workflow.bffless.dev` turns one screen recording into a zip a later
Claude session works from: the transcript with word timings, contact sheets with the clock burned in,
and the direction text typed at kickoff. Today the loop has a person in the middle: they open the
harness, drag the recording onto the kickoff form, run it, and paste the run id into a Claude session,
which then reads the bundle over the harness MCP (`workflow.outputs` → `workflow.sign` → fetch).

The goal is one conversation: the person hands a Claude session **a URL to the recording and a
direction**, and the session owns the run from start to unzipped bundle over the MCP endpoint alone.

Ten of the eleven harness tools already cover this. `workflow.start` over the endpoint dispatches the
implementation's headless driver through GitHub (ADR-0006) and returns the run id at once;
`workflow.status`, `workflow.outputs` and `workflow.sign` cover the rest. The one gap: `capture`'s
`recording` is a `type: file` input, and a `file` input's value is a **whole File ref**
(`{ path, name, contentType, size, url }`) describing bytes already in the project's bucket under
`workflows/<impl>/<workflow>/inputs/`. Only two things mint that ref today — the kickoff form in a
browser and the headless driver given a **local path** — and neither is reachable from an MCP client.

### What was ruled out, and why

- **Handing Claude the video.** claude.ai and the Desktop chat do not accept video attachments at all
  (PDF, Word, spreadsheets, text formats and images only). Even for accepted types an attachment is not
  URL-addressable by a remote MCP server (tool inputs are JSON), and a skill's sandbox egress is
  limited to package registries by default. Getting bytes off a laptop is the person's job, with tools
  built for it (Handoff's drag-and-drop, any public or signed URL). **Non-goal.**
- **A server-side import tool** (`workflow.import { url }` backed by CE's `file_upload_handler`
  `sourceUrl` mode). Works for every caller, but that handler's URL branch buffers the whole body into
  memory (`file-upload.handler.ts` ~L300) and defaults to a 10 MB cap, so it needs a CE streaming patch
  first, and every recording's bytes would transit the CE backend. Rejected for this feature; recorded
  as the alternative if the kickoff page ever wants a URL field.
- **ffmpeg reading URLs directly** (no copy in the bucket). The capture rules confine `source` to an
  uploads-relative path under `workflows/` (R129) and CE's ffmpeg handler resolves `input` as a
  storage key; the manifest records `source.path` as the stored copy. Relaxing all of that for an
  expiring external URL is a different, bigger design. Rejected.
- **A VPS-only skill** that does the upload trio with `curl` and a `bfat_` token. Zero platform change
  but only works from one machine with a stored token; it is the proving step, not the feature.

## Decision

Teach the headless driver that a `file` input's value may be an **`https://` URL**. The driver
downloads it to the runner's disk, then registers it through the same files trio it already runs
for a local path. Nothing server side changes; the tool text says so.

The whole chain, with the one new step in bold:

1. A Claude session calls `workflow.start { impl: "capture", workflow: "capture", inputs: { recording: "https://…/talk.mov", direction: "…" } }` over the endpoint.
2. The drive rule (`rules/api/workflow/run/drive/post`) checks only that `inputs` is a JSON object, forwards it verbatim as `client_payload.inputs` in a `repository_dispatch` to `workflow-implementations`, and answers `pending` with a pre-minted run id.
3. `workflow-drive.yml` writes the payload to `inputs.json` and runs `workflow-headless run … --inputs inputs.json --run-id <id> --wait park`.
4. **The driver sees a string beginning `https://` on a `file` input, streams the download to a temp file, and uploads that file** through `files/prepare` → PUT → `files/register`, swapping the File ref into the kickoff values.
5. The page validates the refs, the run starts, the driver follows it to a terminal status. The session polls `workflow.status` by the id it already holds, then `workflow.outputs` → `workflow.sign` → fetch → unzip.

The bytes still land in the bucket, exactly where a kickoff-form upload puts them. The only
difference is who fetches them.

## Design

### D1 — The URL branch (`packages/workflow-headless/src/upload.ts`)

`uploadFileInputs` today, for each input the workflow declares `type: file`:

| value | today | after |
| --- | --- | --- |
| an object | left alone (already a ref) | unchanged |
| a string | a local path → `uploadOne` | **a string matching `^https?://` → download to temp → `uploadOne`**; any other string → local path, unchanged |
| a `list: true` array | per entry as above | per entry as above |
| an input whose declared type is not `file` | untouched | untouched |

The interpretation is keyed on the **declared type**, never on what the value looks like: a
`type: string` input holding a web address (Capture's `direction` could) passes through verbatim. For
a `file` input a URL has one sensible meaning — the value must become a File ref for the page to accept
the run at all — so "fetch and store" is the only reading that yields a runnable kickoff.

Additive: the URL string is a value that today fails with a file-not-found error from `readFile`, so no
working caller changes behaviour.

### D2 — Download and PUT happen in Node, not through the page, for URL-sourced files

The driver's `ApiLike.put` sends the bucket PUT **through the page** as in-page `fetch`, with the bytes
crossing the Playwright bridge as base64 (`api.ts`). That exists for two reasons — the session cookie
and `--mocks` (MSW is a service worker `page.request` bypasses) — and neither applies to a presigned
bucket PUT of a real run: the URL is presigned (no cookie), and `--mocks` never dispatches. It also
puts a hard ceiling on file size: the whole file in memory, then a base64 string of it across the
bridge (V8's string limit is ~0.5–1 GB), so a long screen recording would fail there before it
reached the bucket.

For a **URL-sourced** file the driver therefore:

1. `fetch(url)` in Node; a non-2xx status fails (D4). Follow redirects (fetch's default).
2. Pipe `response.body` to a file under `os.tmpdir()` as it arrives — never the whole body in memory.
3. `files/prepare` through the page as today (it needs the session; it is a small JSON call), with the
   size from `fs.stat` of the temp file.
4. **PUT from Node**: `fetch(uploadUrl, { method: 'PUT', body: createReadStream(temp), duplex: 'half', headers: { 'content-type', 'content-length': <fs.stat size> } })`. The explicit `Content-Length` matters: a presigned S3/GCS PUT refuses a chunked body (`501 Not Implemented`), and undici only sends a fixed length when the header is set. No CORS applies to a Node request, so the driver's CORS diagnosis for `status: 0` is not reached on this route.
5. `files/register` through the page as today.
6. Delete the temp file whether the upload succeeded or not.

The **local-path** route is untouched in this change (it still reads the file whole and PUTs through
the page). Moving it to the same Node-side streaming PUT is the obvious follow-up and is listed as one,
kept out of scope so this change stays purely additive.

Implementation shape: `uploadOne` is split so its prepare/register halves are reusable, and a
`putFromDisk` sibling to `ApiLike.put` carries the Node PUT. `UploadDeps` grows `download(url) →
{ path, name, contentType, size }` so tests inject a fake and touch no network.

### D3 — Naming and content type

The stored object's name is what the run, the step cards and the zip are named after
(`<recording>.capture.zip`), so it must be the recording's name, not a random id:

- **Filename**: the `Content-Disposition` `filename` (RFC 5987 `filename*` first) if present; otherwise
  the last path segment of **the URL the caller gave** — not the redirect target, which may be a hashed
  or signed storage key — percent-decoded, query string dropped; if that is empty (a URL ending in
  `/`), `download` plus the extension implied by the content type. (A Handoff `/r/…?token=` share link,
  for instance, 302s to a five-minute GCS signed URL with no `Content-Disposition`; the caller's URL is
  the one that ends in the recording's name.)
- **Content type**: the response `Content-Type` (media type only, parameters dropped) when it is not
  `application/octet-stream`; otherwise the extension map already in `upload.ts` (`contentTypeFor`);
  otherwise `application/octet-stream`.

Both are passed to `files/prepare`/`files/register` exactly as a local path's basename and mapped type
are today.

### D4 — Failures

Every failure is a `DriverError` with `EXIT.USAGE` (the existing "your inputs were wrong" exit), a
message naming the **input** and the **URL**, and — through the drive workflow's `if: always()`
artifact upload — visible in the dispatched job's log. The harness row does not exist yet at this
point (the failure is before the page opens), so `workflow.status` for the pre-minted id keeps
answering "no row"; the session's skill treats "no row after the dispatch grace period" as "the
driver refused — read the job log", exactly as it does for a bad local path today.

| case | message shape |
| --- | --- |
| non-2xx download | `download of <input> answered <status> for <url>` |
| network error / no body | `download of <input> failed before a response (<detail>) for <url>` |
| body larger than 5 GB (the files trio's server backstop) | `download of <input> is <bytes> bytes, over the 5 GB cap, for <url>` — checked from `Content-Length` when present, else while streaming |
| `--mocks` with a URL value | `URL file inputs are not supported under --mocks; pass a local path` (D5) |

A `Content-Length` that disagrees with the streamed byte count is not an error (the bucket PUT is the
authority on size); the streamed count is what `prepare`/`register` see.

### D5 — `--mocks` refuses URLs

`--mocks` drives the dev harness's MSW backend with no login and is a developer loop, never a
dispatched run. A Node-side download and PUT would bypass MSW and hit the Vite dev server. Rather than
a second code path, a URL value under `--mocks` is refused with the D4 message. Local paths keep
working under `--mocks` as today.

### D6 — Tool contract text

The `workflow.start` schema text — "a `file` input is a whole File ref (`{ path, name, contentType,
size, url }`), never a bare path or a URL" — becomes:

> a `file` input is a whole File ref (`{ path, name, contentType, size, url }`); over the MCP
> endpoint it may also be an `https://` URL the dispatched driver downloads and registers before
> the run starts. Never a bare path.

Source of truth is `packages/workflow-agent-tools/src/schemas.ts` (`START_SCHEMA`) and
`catalog.ts`. The copies under `apps/workflow/.bffless/proxy-rules/workflow/mcp-fn/*.fn.js` and
`rules/api/workflow/mcp/any.rule.yaml` are **generated** by `pnpm --filter workflow mcp:build` and
guarded by `src/mcp/bundle.test.ts`, so the change is one edit plus a rebuild. The driver's README
(`packages/workflow-headless/README.md`) and spec 07's "file inputs" paragraph get the same sentence.
The schema **shape** does not change: `inputs` was already a free-form object.

The page's own validation (`lib/autoStart.ts`, `validateValue('file', …)`) is **not** loosened: on the
harness page a `file` input is still a whole File ref. The page has drag-and-drop; a URL field there is
the server-side import alternative, out of scope.

### D7 — The skill: *capture a recording*

A skill that takes a recording URL and a direction and owns the run. It never lists runs to find one;
the only id it uses is the one `workflow.start` returned — picking "the newest succeeded capture run"
is a guess that breaks when two recordings run at once and the shorter finishes first.

1. `workflow.describe { impl: capture, workflow: capture }` once, to confirm `headlessSafe` and read
   the inputs (language, interval) so the skill can pass them through when the person names them.
2. `workflow.start` with `{ recording: <url>, direction: <text>, language?, interval? }`; keep the id.
3. Poll `workflow.status { runId }`: no row for the first ~90 s is the dispatch delay; no row after
   ~3 min is a driver refusal (D4) and the skill says so and stops. Then follow the steps to a terminal
   status; on `failed`, report the failed step's error from the snapshot.
4. On `succeeded`: `workflow.outputs { runId }`, `workflow.sign { runId, path: <bundle.path> }`, fetch
   the zip to the session's scratch directory, unzip, read `manifest.json` then `transcript.md`, open
   `sheets/*.jpg` as images (or, past the 150 MB cap where `manifest.embedded` is `false`, sign each
   `manifest.sheets[].path`). `manifest.sheets[].times` maps cells to seconds.

Home: `bffless/skills` (`plugins/bffless/skills/capture-recording/SKILL.md`), the published plugin
that reaches both Claude Code and other hosts; the `capture` README's "Reading a run from a Claude
session" section links to it. This spec's implementation plan covers the skill's text; the
`bffless/skills` release is its own PR.

## Testing

- **Unit (`packages/workflow-headless/test/upload.test.ts`)** with the existing `fakeApi` plus a fake
  `download` dep: URL value → download called, prepare/PUT/register called with the downloaded name,
  size and content type, temp file removed; local path unchanged; mixed `list: true` array of one URL
  and one path; `type: string` input holding a URL untouched; non-2xx download → `DriverError`
  `EXIT.USAGE` naming input and URL; oversize → refused; `--mocks` + URL → refused. Filename and
  content-type derivation (D3) table-tested: `Content-Disposition` wins, `filename*`, URL last
  segment with query and percent-encoding, trailing slash, `octet-stream` falls back to the extension.
- **Node PUT** unit-tested against a local `http.createServer` that records method, headers and byte
  count, so the streaming body is proven without a bucket.
- **Live walk**: `packages/workflow-live` gains a `capture-url` walk (or the `headless` walk gains a
  URL variant) that starts `capture/capture` over the MCP endpoint against `workflow.j5s.dev` with a
  recording URL — the committed default is the public, tokenless Handoff content URL
  `https://handoff.j5s.dev/api/uploads/content/test-public/anatomy.mp4` (41 MB `video/mp4`, answers
  200 directly, no redirect, does not expire), overridable with `CAPTURE_FIXTURE_URL` — waits for
  `succeeded`, signs the bundle and asserts the zip contains `manifest.json` whose `source.name` is the
  recording's filename. Run with `apps-live-walk` after the
  driver release lands (the dispatched job installs `@bffless/workflow-headless@^1.2` fresh).
- **`bundle.test.ts`** in `apps/workflow` fails if the regenerated `mcp-fn` bundles are stale after the
  D6 text edit; `pnpm --filter workflow mcp:build` is part of the verify chain.

## Rollout

1. Merge the driver change → release-please cuts `@bffless/workflow-headless` **1.4.0** (a `feat`) and
   `release.yml` publishes it. `workflow-drive.yml` installs `^1.2`, so the next dispatch picks it up
   with **no change** to `workflow-implementations`.
2. Merge the D6 text change → the harness rule set republishes on deploy; `workflow.describe`/`list`
   output is unaffected, only the `start` description changes.
3. Publish the skill in `bffless/skills`; update the `capture` README link.
4. Prove it end to end from this workspace with the live walk, then from a Claude Desktop session with
   the same URL.

## Follow-ups (recorded, not in scope)

- **Streaming PUT for local paths** — move the local-path route onto the D2 Node-side streaming PUT so
  a multi-GB local recording stops going whole through memory and the base64 bridge.
- **A URL field on the kickoff page** — the server-side import alternative (CE streaming patch to
  `file_upload_handler`'s URL branch + a `files/import` rule), if a person at the page ever wants it.
- **Publish the bundle to Handoff from inside the run** — already listed in the capture spec's
  follow-ups; pairs with this so the session gets a share link, not just a signed URL.
- **`maxSize` from the input declaration** — the driver's `InputDecl` carries only `type`/`list`; reading
  the declared `maxSize` (`5GB` for `recording`) would refuse an oversize download before the
  5 GB server backstop does, with the workflow's own number in the message.
