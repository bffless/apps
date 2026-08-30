# studio: SceneAssembleBar download streams the saved scene MP4 through file_serve — should sign an attachment URL like FinalCutBar

Found while checking what apps-side work ce#697 (`file_serve_handler` Content-Disposition) would unblock. This one needs **no CE change** — the mechanism already exists and is used one component over.

## What happens

In `apps/studio/src/components/Studio/SceneAssembleBar.tsx`, playback of a saved scene is signed to a direct bucket URL, but the Download link is not:

```ts
const { data: signedAssembled } = useSignDownloadQuery(scene.assembledUrl ?? skipToken)
const playbackSrc = resultUrl ?? (scene.assembledUrl ? (signedAssembled?.url ?? null) : null)
const downloadHref = resultUrl ?? scene.assembledUrl ?? null   // <- raw serve path
```

So when a previously-saved scene is reloaded (no fresh local blob, `resultBlob` is null), `downloadHref` is the `/api/uploads/...` serve path and clicking **Download** streams the whole scene MP4 through `file_serve`.

That is exactly the path the codebase elsewhere says must never carry big MP4s:

- the sign rule's own description — "so the browser reads large files (source video) straight from the bucket instead of streaming them through file_serve (504/OOM on big files)" (`apps/studio/.bffless/proxy-rules/studio/rules/api/uploads/sign/post/rule.yaml`)
- `FinalCutBar.tsx:57-62` — "must never stream through file_serve (bffless/ce#317)"
- `studioApi.ts:236-241` — "the serve pipeline streams the object through the BFFless backend, which 504s/OOMs on big files"

Fresh in-browser assembles are fine: `resultUrl` is a same-origin `blob:` URL where the `download` attribute does apply. The bug is only on the reload-then-download path.

## Why it is still like this

The comment above the block explains the original reasoning:

```
// The download link keeps the serve path: `download` is ignored on
// cross-origin URLs, so signing it would cost the filename.
```

That was true before `signAttachment` existed. It is now stale — `studioApi.ts:258` `signAttachment` mints a signed bucket URL that forces `Content-Disposition: attachment` under a caller-supplied `filename`, and the sign rule already passes `filename: steps.resolvePath.filename` into the `signed_url` step. `FinalCutBar.tsx:63-70` uses exactly this and is the reference implementation:

```ts
const { data: signedAttachment } = useSignAttachmentQuery(
  finalCutUrl ? { url: finalCutUrl, filename: downloadName } : skipToken,
)
const downloadHref = resultUrl ?? (finalCutUrl ? (signedAttachment?.url ?? null) : null)
```

`SceneAssembleBar` simply never got switched over.

## Expected

Downloading a saved scene reads straight from the bucket, keeping the `scene-<n>.mp4` filename — no bytes through the backend.

## Suggested fix

Mirror `FinalCutBar`:

1. Hoist the filename (today it is inline on the anchor as `` download={`scene-${scene.index + 1}.mp4`} ``) into a `downloadName` const.
2. Add `useSignAttachmentQuery(scene.assembledUrl ? { url: scene.assembledUrl, filename: downloadName } : skipToken)`.
3. `const downloadHref = resultUrl ?? (scene.assembledUrl ? (signedAttachment?.url ?? null) : null)`.
4. Replace the stale comment with the `FinalCutBar` wording (playback inline vs. download attachment need different signatures; the `blob:` fallback is same-origin so `download` still applies there).
5. Keep the `download` attribute for the `blob:` case.

Test alongside `FinalCutBar.test.tsx`, which already spies on `signAttachmentSpy` and asserts the args — the same shape works here.

## Notes

- No proxy-rule or schema change; `apps/studio` rules are untouched.
- Unrelated to #362, which is the `file_serve_handler` half and stays blocked on bffless/ce#697.

