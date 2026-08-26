/**
 * The server-data layer (09): discovery, workflow files and the run record, all
 * of it through RTK Query so caching, in-flight state and invalidation are the
 * same everywhere — and all of it through the coercers, so a mocked answer and a
 * real one are indistinguishable above this module.
 *
 * The base query wraps `fetchBaseQuery` with the reauth policy every BFFless app
 * needs: a run outlives the SuperTokens access token, and once it expires every
 * `/api/*` call answers `401 {"message":"try refresh token"}`. One refresh, then
 * the request is retried in place (R5).
 */
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import type {
  BaseQueryFn,
  FetchArgs,
  FetchBaseQueryError,
  FetchBaseQueryMeta,
} from '@reduxjs/toolkit/query/react'
import {
  toAliasList,
  toImplementation,
  toRunRow,
  toStepRow,
  toWhoami,
  unwrapRows,
} from '../lib/coerce'
import type { Implementation, ServerRunRow, ServerStepRow, Whoami } from '../lib/coerce'
import { aliasesUrl } from '../lib/discovery'
import { fetchPayloadCached, forgetPayloads } from '../lib/payloadFetch'
import { hydrateOutputs } from '../lib/runner/payload'

/** SuperTokens' own refresh route, reached through the harness's `/api/auth/*` rule. */
const REFRESH_URL = '/api/auth/session/refresh'

/**
 * SuperTokens *rotates* the refresh token, so two concurrent refreshes race on
 * the same cookie: the first rotation invalidates the token the others hold. A
 * run fans out into many parallel calls that all 401 at once, so the shared
 * in-flight promise is the common path, not the edge case.
 */
let refreshInFlight: Promise<boolean> | null = null

async function requestRefresh(): Promise<boolean> {
  try {
    const res = await fetch(REFRESH_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { rid: 'session' },
    })
    return res.ok
  } catch {
    return false
  }
}

function attemptRefresh(): Promise<boolean> {
  refreshInFlight ??= requestRefresh().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

/** The run `getRun` last hydrated — the payload memo's scope. */
let lastHydratedRunId: string | null = null

const rawBaseQuery = fetchBaseQuery({ baseUrl: '/' })

/**
 * `Meta` carries `FetchBaseQueryMeta` (the raw `Response`) through explicitly:
 * `probe()` reads `result.meta?.response?.headers` off exactly this base
 * query, and a default `{}` Meta would type that away.
 */
type ReauthBaseQuery = BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError,
  object,
  FetchBaseQueryMeta
>

const baseQueryWithReauth: ReauthBaseQuery = async (args, api, extraOptions) => {
  const result = await rawBaseQuery(args, api, extraOptions)
  if (result.error?.status !== 401) return result
  return (await attemptRefresh()) ? rawBaseQuery(args, api, extraOptions) : result
}

/**
 * The shape RTK Query actually hands a `queryFn` its own `baseQuery` as —
 * unary, `Parameters<BaseQuery>[0]) => ReturnType<BaseQuery>` — not the full
 * 3-argument `BaseQueryFn`. Derived from `ReauthBaseQuery` so the two can
 * never drift apart.
 */
type ProbeBaseQuery = (arg: Parameters<ReauthBaseQuery>[0]) => ReturnType<ReauthBaseQuery>

/**
 * The outputs map a coerced row carries. `RunRow.outputs`/`StepRow.outputs`
 * are declared as wide as the raw column is (`unknown`), but everything that
 * reaches here came through `toRunRow`/`toStepRow`, which already narrowed it
 * to a record or `null` — this restates that fact for the type system without
 * re-parsing (one parser, 09).
 */
function outputsOf(row: { outputs?: unknown }): Record<string, unknown> | null {
  const outputs = row.outputs
  return outputs !== null && typeof outputs === 'object' && !Array.isArray(outputs)
    ? (outputs as Record<string, unknown>)
    : null
}

/** `/w/<impl>/.bffless/workflows/<file>` — the implementation's published bundle (06). */
function publishedPath(impl: string, file: string): string {
  return `w/${impl}/.bffless/workflows/${file}`
}

/**
 * One alias probed for an `index.json`, through the endpoint's own
 * `baseQuery` (M1 minor, apps#363) rather than a raw `fetch`: a run outlives
 * the access token exactly as much during discovery as anywhere else, and a
 * probe that read an expired session's 401 straight as "not published" would
 * silently drop every implementation until the member reloaded. Routing
 * through `baseQueryWithReauth` means one 401 mid-discovery is retried once,
 * the same as every other endpoint (R5).
 *
 * "Not an implementation" (ADR-0004) is not only a 404: a BFFless SPA answers
 * *any* unknown path with its `index.html`, 200 and all, and that is the common
 * shape of an ordinary alias in these projects. So the answer only counts as a
 * publish when the server says it is JSON *and* the body actually parses as
 * JSON — a body that claims to be JSON but is not is indistinguishable from
 * the SPA-fallback case, so both drop the alias like a 404 rather than listing
 * it as somebody's broken workflow.
 *
 * A publish that *does* parse but cannot be used — a future `spec`, no
 * `workflows` — still stays on the list carrying its error (`toImplementation`
 * never throws for that; it returns the same `{ error }` shape `unusable`
 * builds here), because a broken publish the user cannot see is worse than one
 * they can (08). `unusable` is reserved for an actual transport failure: a
 * non-404 error status, or the request failing outright.
 */
async function probe(
  alias: string,
  preview: boolean,
  baseQuery: ProbeBaseQuery,
): Promise<Implementation | null> {
  const unusable = (error: string): Implementation => ({
    alias,
    name: alias,
    preview,
    workflows: [],
    error,
  })

  const result = await baseQuery({ url: publishedPath(alias, 'index.json'), responseHandler: 'text' })

  if (result.error) {
    if (result.error.status === 404) return null
    const message =
      'error' in result.error && typeof result.error.error === 'string'
        ? result.error.error
        : `index.json answered ${result.error.status}`
    return unusable(message)
  }

  const contentType = result.meta?.response?.headers.get('content-type') ?? ''
  if (!contentType.includes('json')) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(result.data as string)
  } catch {
    return null
  }

  return toImplementation(alias, preview, parsed)
}

export const workflowApi = createApi({
  reducerPath: 'workflowApi',
  baseQuery: baseQueryWithReauth,
  tagTypes: ['Runs', 'Run'],
  endpoints: (builder) => ({
    /**
     * Discovery: the project's aliases, each probed in parallel. The harness's
     * own alias is not special-cased — it simply has no `index.json`.
     * `aliasesUrl()` is the harness relay rule (Decision 4 fallback: the
     * harness host has no CE alias API of its own — an unmatched `/api/*` falls
     * through to the SPA's `index.html`), scoped to this build's project when
     * `VITE_BFFLESS_PROJECT` is set (apps#363).
     */
    discover: builder.query<Implementation[], void>({
      async queryFn(_arg, _api, _extraOptions, baseQuery) {
        const aliases = await baseQuery(aliasesUrl())
        if (aliases.error) return { error: aliases.error }
        const probed = await Promise.all(
          toAliasList(aliases.data).map((alias) => probe(alias.name, alias.isAutoPreview, baseQuery)),
        )
        return { data: probed.filter((impl): impl is Implementation => impl !== null) }
      },
    }),

    /**
     * Who the session is (Task 19's `whoami` rule) — the only place the app
     * learns its own identity. M1 had none (R8), so the shell showed no user
     * and Delete's owner gate had nothing to compare against.
     *
     * Untagged and therefore cached for the life of the app: the identity
     * behind a session does not change without a new session, and the rule is
     * a read of `user.*` with no record behind it.
     *
     * The answer is *advisory*: every rule that cares re-reads `user.*`
     * server-side, so a tampered reply can only ever offer a button the server
     * then refuses (403), never widen what a caller may actually do.
     */
    whoami: builder.query<Whoami, void>({
      query: () => 'api/workflow/whoami',
      transformResponse: toWhoami,
    }),

    /** The workflow's YAML, by the `file` its listing names (R1). */
    getWorkflowYaml: builder.query<string, { impl: string; file: string }>({
      query: ({ impl, file }) => ({ url: publishedPath(impl, file), responseHandler: 'text' }),
    }),

    /** Past runs of one workflow, newest first (sorting is client-side, Decision 6). */
    listRuns: builder.query<ServerRunRow[], { impl: string; workflow: string }>({
      query: ({ impl, workflow }) => ({ url: 'api/workflow/runs', params: { impl, workflow } }),
      transformResponse: (raw: unknown) =>
        unwrapRows(raw)
          .map(toRunRow)
          .sort((a, b) => b.startedAt - a.startedAt),
      providesTags: ['Runs'],
    }),

    /**
     * One run and all its step rows — what Resume and the read-only view fold (05).
     *
     * This is the **only** place a `{"$file"}` payload is dereferenced (Task
     * 13). An output over the persistence budget is stored as a pointer
     * (`lib/runner/payload.ts`'s `offloadOutputs`), but nothing above this
     * module should ever have to know that: `replayRun`, the run page's
     * renderers and every `steps.<key>.outputs.<name>` expression are written
     * against *values*, and expressions in particular are synchronous, so the
     * dereference has to have already happened by the time a row leaves here.
     * `openRun`/`takeOver` (lifecycleActions.ts) therefore need no hydration
     * step of their own — they are handed what this endpoint produced.
     *
     * A `queryFn` rather than a `transformResponse` because the hydration is
     * asynchronous; the row fetch still goes through the endpoint's own
     * `baseQuery`, so `baseQueryWithReauth`'s 401-refresh-retry (R5) applies
     * exactly as before. A payload that cannot be read never fails the query —
     * `fetchPayload` resolves it to the `{ $file, $error }` sentinel instead.
     *
     * Every payload is read through `fetchPayloadCached` (apps#375): the 5 s
     * poll of a running run re-issues this query, and a payload is immutable
     * once written, so a path read once is not read again while this run is
     * the one being viewed.
     */
    getRun: builder.query<{ run: ServerRunRow | null; steps: ServerStepRow[] }, string>({
      async queryFn(id, _api, _extraOptions, baseQuery) {
        // The payload memo (`fetchPayloadCached`) is scoped to one run: a
        // read of a different run drops it, so the memo never grows past
        // what the run on screen offloaded (apps#375).
        if (id !== lastHydratedRunId) {
          forgetPayloads()
          lastHydratedRunId = id
        }
        const res = await baseQuery({ url: 'api/workflow/run', params: { id } })
        if (res.error) return { error: res.error }

        const record = (res.data ?? {}) as { run?: unknown; steps?: unknown }
        const run = record.run ? toRunRow(record.run) : null
        const steps = unwrapRows(record.steps).map(toStepRow)

        // One row's payloads are independent of every other row's, so the
        // whole record hydrates in one round trip's worth of wall time.
        const [runOutputs, ...stepOutputs] = await Promise.all([
          hydrateOutputs(run === null ? null : outputsOf(run), fetchPayloadCached),
          ...steps.map((step) => hydrateOutputs(outputsOf(step), fetchPayloadCached)),
        ])

        return {
          data: {
            run: run === null ? null : { ...run, outputs: runOutputs ?? null },
            steps: steps.map((step, i) => ({ ...step, outputs: stepOutputs[i] ?? null })),
          },
        }
      },
      providesTags: (_result, _error, id) => [{ type: 'Run' as const, id }],
    }),
  }),
})

export const {
  useDiscoverQuery,
  useGetWorkflowYamlQuery,
  useGetRunQuery,
  useListRunsQuery,
  useWhoamiQuery,
} = workflowApi
