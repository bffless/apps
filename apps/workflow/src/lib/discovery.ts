/**
 * Discovery scope (apps#363): which project's aliases `discover` probes.
 *
 * A catalog-installed harness runs against one BFFless project, but the
 * discovery relay (`api/workflow/aliases`) has no way to know which project
 * that is on its own — it answers every alias the calling session can see
 * (Manual setup's Decision 4 finding). `VITE_BFFLESS_PROJECT`, baked in at
 * build time by `deploy-workflow.yml`, scopes the aliases request to this
 * harness's own project; unset (dev, mocks, CI) leaves it unscoped, which is
 * exactly what those environments' single-project mock/test fixtures need.
 * Runtime self-discovery for a catalog install — reading the project the
 * harness was installed into rather than baking it in at build time — is M4
 * (apps#363's remaining half).
 */

/** The `owner/repo` this build was deployed for, or `undefined` when unscoped. */
export function projectRepository(): string | undefined {
  const raw = import.meta.env.VITE_BFFLESS_PROJECT
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

/** `api/workflow/aliases`, scoped to `projectRepository()` when one is set. */
export function aliasesUrl(): string {
  const repository = projectRepository()
  return repository === undefined
    ? 'api/workflow/aliases'
    : `api/workflow/aliases?repository=${encodeURIComponent(repository)}`
}
