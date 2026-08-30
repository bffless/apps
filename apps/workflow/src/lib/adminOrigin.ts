/**
 * Origin of the BFFless **admin host** that owns this instance.
 *
 * The harness is served at `<app>.<primary-domain>` (e.g. `workflow.example.com`)
 * and the admin always lives at `admin.<primary-domain>`. We derive that by
 * swapping the first hostname label for `admin`, so a fork works on **any**
 * instance with no code edit — an instance host hardcoded in `src/` is a bug
 * (`apps/handoff/src/lib/session.ts` precedent). Set `VITE_ADMIN_URL`
 * (e.g. `https://admin.example.com`) to override for non-standard topologies or
 * local dev where the host isn't `<app>.<primary-domain>`.
 */
export function adminOrigin(): string {
  const override = import.meta.env.VITE_ADMIN_URL as string | undefined
  if (override) return override.replace(/\/+$/, '')
  const { protocol, hostname, host } = window.location
  const labels = hostname.split('.')
  // <app>.<primary…> → admin.<primary…>; single-label hosts (localhost) are left as-is.
  const adminHost = labels.length > 1 ? ['admin', ...labels.slice(1)].join('.') : host
  return `${protocol}//${adminHost}`
}
