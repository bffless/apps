# 03n — snap-to-verbatim: original tags drive, boundaries get fixed

> Read `00-architecture-and-state.md` first; this amends the 03j verbatim guard
> in `toRefinement` (`src/lib/refiner.ts`). FE-only — no pipeline changes.

**Status:** ✅ shipped (2026-06-11, debugged + TDD'd live against a real failing
run; rides PR #20 with 03l/03m).

## The bug (root-caused from job `b20dde31`, 2026-06-11)

A creator directed "only use original audio" (03l prompts working as designed)
and Gemini obeyed: **all four segments came back `source: 'original'`** with
sensible cuts. But the UI loaded two of them as `revoice` — the 03j verbatim
guard demoted them client-side, because each span's WhisperX words didn't match
the segment text exactly:

- `[21.2 → 34]` — the tail of a false start ("…allow you to") extends past
  21.2, so the span's real audio held extra words the text omits.
- `[35 → 43]` — the repeated "or when they create an account" begins just
  before 43, same problem at the other edge.

Root cause: a **granularity mismatch**. The model places boundaries from
~8-second-granular transcript lines (plus audio), but the guard demanded
word-level span membership — so near repetitions *of the same words*, a
half-second miss silently threw the tag away and forced re-record/AI.

## The fix — the model's tag is authoritative; its clock positions are not

In `toRefinement`, when an `'original'` segment's text doesn't match its span:

1. **Snap.** Search the scene's words for the text as a CONTIGUOUS normalized
   word-run (`findVerbatimRun`). Among multiple occurrences (repeated takes!)
   the one nearest the claimed start wins; runs overlapping the previous
   segment are skipped. On a hit, the segment's span snaps to the matched
   words' real timestamps and the tag survives → auto-adopt slices exactly the
   clean take.
2. **Fix the cuts to follow.** Cuts the snapped span expands into are shrunk
   (`removeCut` — assemble's cut-wins rule must never silence a kept span);
   displaced slivers become cuts **only when they hold words** (the junk the
   model believed it had excluded) — wordless slivers stay kept dead air,
   matching the gaps-are-intentional semantics.
3. **Downgrade only as the true fallback** — when the text exists nowhere
   verbatim (genuine rewrite/omission), or no words are passed. Unchanged from
   03j; all 03j tests still pass.

A span whose words already match keeps the model's exact boundaries (padding
silence is the model's choice) — no gratuitous re-anchoring.

## Tests (`refiner.test.ts`, +6 — fixtures model the real failing recording)

- snaps a late boundary off false-starts of the same words; tag kept
- displaced junk-word sliver merges into the adjacent cut; wordless sliver
  stays a gap
- repeated takes: snaps to the occurrence nearest the claimed span
- a cut the snapped span expands into is shrunk
- text existing nowhere contiguously still downgrades
- never snaps into the previous segment (downgrades instead)

## Notes

- Already-committed refinements keep their demoted tags (the guard runs at
  refine time) — Revert + Re-refine re-runs through the new path.
- Out of scope: surfacing remaining (now-rare, genuine) downgrades in the UI;
  word-level timestamps in the refiner prompt.
