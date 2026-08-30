# Fixtures

`onboarding-rules.mp4` — the recording behind Studio's first by-hand live run
(`run_01M17CG3W0YTA4T0ZVRTD88VE7`, 2026-08-29): "How to set up onboarding rules and public
signups in BFFless", ~4 min, spoken audio. Fetched once with `fetch-clip.mjs` from the
`bffless/workflow` project's `inputs/` and transcoded with `transcode.sh` (480p, CRF 30, mono AAC).
`onboarding-rules.sha256` pins it; `src/fixture.ts` verifies before every Studio kickoff.

A synthetic `testsrc` clip cannot stand in: a run whose recording has no spoken audio fails by
design (apps#483).

## Provenance (2026-08-30)

- Source: 41,882,447 bytes, 1920×1080, fetched via `fetch-clip.mjs`.
- Transcoded with `transcode.sh` → `onboarding-rules.mp4`: 3,563,614 bytes (3.4 MiB), 854×480,
  H.264 video + AAC mono audio, 223.9 s duration.
- sha256: `7a1049759b416e6c3c7a09b031d76b060c4f483850937b88f69478e7f9004f22`

At 3.4 MiB the transcoded clip is well under the 15 MB threshold, so it is **committed directly**
to `fixtures/onboarding-rules.mp4` — no GitHub release asset, no `.gitignore` entry. The
committed file is the only source: `ensureClip()` has no download fallback, and a checkout where
it is missing (or fails the sha256 pin) throws — the `studio-headless` walk reports that as
`BLOCKED`. If the clip is ever lost, regenerate it with `fetch-clip.mjs` + `transcode.sh` and
re-pin `onboarding-rules.sha256`.
