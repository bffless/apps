# 07 — Stripe gating of paid features

> Read `00-architecture-and-state.md` first.

**Status:** ⏳ queued · **Backend: BFFless Stripe + auth.** Do last — after the
paid pipelines exist.

## Goal

The AI/Replicate steps cost real money (transcribe, shorten+segment, voice
clone + per-scene TTS, nano-banana). Gate those behind auth + a subscription /
credits check. The free tier is whatever runs locally for free (import, the
browser audio/frame stages, the manual scene editor UI) — the paid tier unlocks
the model calls and assemble.

## Backend

1. `stripe_checkout` (`/api/billing/checkout`) — subscription or credit packs;
   `successUrl`/`cancelUrl` back to `/studio`; `environment: test` until launch.
2. `stripe_webhook` (`/api/billing/webhook`) — validate signature, update the
   user's entitlement (a Data Table: `userId → plan/credits/renewsAt`).
3. Add an **entitlement check** to each paid pipeline (a shared `function_handler`
   early step or validator) that 402s when the user lacks plan/credits — fulfill
   the `auth_required` TODOs left in stories 02–04. Decrement credits in
   `postSteps` after a successful paid run if using packs.

## Front-end

1. `src/lib/useEntitlement.ts` — `{ plan, credits, canUseAI }` (via `useBffState`
   or `/api/billing/me`).
2. When `!canUseAI`, show a tasteful paywall on the prep/run and per-scene voice
   actions (reuse `.pill-cta`, paper/ink/terracotta), with "Start subscription" →
   `/api/billing/checkout`. Handle the post-checkout return (refetch entitlement,
   confirm).

## Acceptance criteria

- [ ] Unentitled users can import + browse the UI; AI actions show a paywall.
- [ ] After a test-mode checkout + webhook, entitlement flips and AI unlocks.
- [ ] Paid pipelines 402 server-side when unentitled (not just hidden in UI).
- [ ] Webhook updates the table; credits decrement (if used); test-mode E2E with
      Stripe test cards; build/lint/tests pass.

## Notes

See the `cache-and-storage` and `bffless` skills for Stripe handler + webhook
secret setup. Keys/secrets stay in BFFless config, never in the client bundle.
Use `gh` for any repo/CI wiring, never `curl`.
