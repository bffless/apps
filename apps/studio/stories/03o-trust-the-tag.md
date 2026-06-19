# 03o — trust the tag: stop re-checking `original` against the transcript

> Read `00-architecture-and-state.md` first. This removes the verbatim guard that
> 03j/03n layered onto `toRefinement` (`src/lib/refiner.ts`). FE-only.

**Status:** ✅ shipped (2026-06-12). Paired with 03p (which sends the model
precise word times so the now-trusted boundaries are accurate).

## The bug (from the 2026-06-12 screenshots)

The refiner returned all segments `source: 'original'` (the creator asked for
original-only), but the UI loaded the **first** as `revoice` — no "Use original"
chip, no auto-adopt. The model echoed *"I'm **gonna** be going…"* while WhisperX
transcribed *"I'm **going to** be going…"*. Same audio; only the reduction's
spelling differs. The exact-string verbatim guard tripped, the 03n snap couldn't
find `gonna` as a contiguous run, and it fell through to a downgrade.

## Why we stopped guarding instead of patching the matcher

A first fix expanded a `gonna→going to` contraction map. James pushed back: that's
whack-a-mole (next it's `Smyth/Smith`, a dropped filler), and it misses the real
question — *if the model says "play original from X to Y", why are we re-deriving
that from the words at all?*

The honest answer: the guard existed because the model only ever saw the
**8s-bucketed** transcript (`timedTranscript`), so its timestamps were coarse and
we leaned on the text to recover precise boundaries. But the text channel is
exactly what drifts (orthography), so the guard fought correct tags.

**Decision:** trust the model. An `original`/`revoice` tag passes straight through
to `suggestedSource`; the segment keeps the model's own `start`/`end` (clamped +
non-overlapping). No verbatim check, no snap, no contraction map, no downgrade.
The accepted cost — a coarse span may include a false start — is fixed at the
SOURCE in [[03p-word-timings-from-scratch]] (send precise per-word times), not by
second-guessing the tag here.

## Removed

`normWords`, `findVerbatimRun`, the `WordToken` type, the contraction map, the
snap-fixup cut math, and the `words` parameter of `toRefinement` (now `(raw,
scene)`). `completeRefineJob` no longer passes `words`.

## Tests

`refiner.test.ts`: the 03j voicing-source block rewritten to assert tags pass
through (incl. the real `gonna`/`going to` line staying `original`); the whole 03n
snap block deleted. All downstream (`suggestedOriginalIndices`, `voicingSummary`,
auto-adopt) unchanged — they still key off `suggestedSource`.

## Note

Already-committed refinements keep whatever they were tagged at refine time —
Revert + Re-refine re-runs through the new path.
