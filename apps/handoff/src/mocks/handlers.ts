/**
 * MSW request handlers for the Handoff app. When the master switch in
 * `config.ts` is on, this worker intercepts `/api/*` requests in dev. When the
 * switch is off the worker never starts, so all requests go directly to the
 * network via the Vite proxy. Only active in dev — MSW isn't started in prod
 * (see `main.tsx`).
 *
 * Add handlers here as feature slices land (#7+).
 */

export const handlers = [] as const
