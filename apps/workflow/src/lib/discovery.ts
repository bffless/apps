/**
 * Discovery scope (apps#363): which project's aliases `discover` probes.
 *
 * A catalog-installed harness runs against one BFFless project, but the
 * discovery relay (`api/workflow/aliases`) has no way to know which project
 * that is on its own — it answers every alias the calling session can see
 * (Manual setup's Decision 4 finding). Since M4 the harness discovers that
 * project itself, **at runtime**: `GET /api/workflow/project` (the serving
 * rule set) reads CE's `deployment` provenance root, which the 2026-08-31
 * live probe proved names the serving project — `bffless/workflow`, not the
 * git repo the bundle was built from (bffless/README.md, "M4 Phase 2").
 *
 * Precedence: `VITE_BFFLESS_PROJECT`, when baked in at build time
 * (`deploy-workflow.yml` sets it as an *override* — it saves the one request
 * and pins CI deploys explicitly) → else the runtime answer, fetched once and
 * cached for the session → else unscoped, exactly what dev/mocks/CI's
 * single-project fixtures and an instance with no provenance need (the
 * unscoped list is role-scoped server-side since ce#702, so falling back
 * open leaks nothing).
 */

/** The `owner/repo` this build was deployed for, or `undefined` when unscoped. */
export function projectRepository(): string | undefined {
  const raw = import.meta.env.VITE_BFFLESS_PROJECT
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? undefined : trimmed
}

/**
 * The one runtime read, memoized for the session: the serving project does
 * not change under a running SPA (it is deployment provenance), and `discover`
 * refetches on every Implementations mount. Never rejects — any failure
 * (non-200, bad JSON, network) answers `undefined`, preserving the unscoped
 * fallback rather than turning a scoping nicety into an outage.
 */
let runtimeRepository: Promise<string | undefined> | null = null

async function requestProjectRepository(): Promise<string | undefined> {
  try {
    const res = await fetch('/api/workflow/project')
    if (!res.ok) return undefined
    const body: unknown = await res.json()
    const repository =
      body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>).repository
        : undefined
    const trimmed = typeof repository === 'string' ? repository.trim() : ''
    return trimmed === '' ? undefined : trimmed
  } catch {
    return undefined
  }
}

/**
 * The project to scope discovery to: the build-time override if set, else the
 * runtime answer from the serving rule set, else `undefined` (unscoped).
 */
export function fetchProjectRepository(): Promise<string | undefined> {
  const override = projectRepository()
  if (override !== undefined) return Promise.resolve(override)
  runtimeRepository ??= requestProjectRepository()
  return runtimeRepository
}

/** Test-only: the memo is module-level; one test's answer must never scope the next test's. */
export function forgetProjectRepository(): void {
  runtimeRepository = null
}

/** `api/workflow/aliases`, scoped to `fetchProjectRepository()` when one resolves. */
export async function aliasesUrl(): Promise<string> {
  const repository = await fetchProjectRepository()
  return repository === undefined
    ? 'api/workflow/aliases'
    : `api/workflow/aliases?repository=${encodeURIComponent(repository)}`
}
