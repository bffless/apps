/**
 * `drivePlan` — the first function step of the `run/drive` rule (ADR-0006,
 * apps#598): everything the *index fetch* needs, computed before it runs.
 *
 * The rule dispatches an implementation's `workflow-drive.yml`, and only the
 * implementation's own `index.json` says which repo that is (`driver.repo`,
 * written by `workflow index --driver-repo`). Which implementation, though,
 * depends on the mode: a `run` names it in the body (there is no run row yet);
 * a `resume` gets it from the run row the `find` query already read, because
 * the caller passes nothing but the id. So the URL of the fetch is a step's
 * output, not a constant — which is exactly what a function step is for. CE
 * step conditions are simple paths, so `hasIndex` is the flag the `index` step
 * is gated on, and `indexUrl`/`indexPath` are the expressions it reads.
 *
 * Nothing here judges the request: a malformed body plans no fetch and the
 * gate (one step later, with the index in hand) says why in one place. This
 * function cannot do I/O and must never throw — a throw is CE's generic
 * FUNCTION_ERROR, not a status this rule gets to choose.
 */
import { fieldsOf, rows } from './rows'
import { header, siblingBaseOf, type FnRequest } from './route'

/** This rule's own public path — where the alias's base path ends (`siblingBaseOf`). */
export const DRIVE_PATH = '/api/workflow/run/drive'

/**
 * An implementation alias, as CE names deployment aliases and as `/w/<impl>/`
 * forwards them. It is interpolated into the index URL, so the shape is a
 * fence as much as a validation: nothing here can carry a `/`, a `..` or a
 * query into a sibling call.
 */
export const IMPL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/

export interface DrivePlan {
  /** Gate of the `index` step: there is an implementation to ask and a base to ask it at. */
  hasIndex: boolean
  /** Where the index fetch goes (CE in-process at the request's own base path). */
  indexUrl: string
  /** Its public-relative path — CE's proxy middleware matches rules on `x-original-uri`, not on the `/public/…` URL. */
  indexPath: string
  /** The implementation whose driver is dispatched: the body's (`run`) or the run row's (`resume`). */
  impl: string
  siblingBase: string
  /** The public host (`x-forwarded-host ?? host`), sent back to CE on the in-process call. */
  host: string
  /** `https://<host>` — the `harness_url` the driver is told to call back on. */
  appOrigin: string
  /** The body's `mode`, unjudged (the gate judges it). */
  mode: string
  /** The body's `id`, unjudged. */
  runId: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function handler(data: { request?: FnRequest; steps?: { find?: unknown } }): DrivePlan {
  const request = data?.request ?? { body: undefined, headers: {}, method: 'POST', path: '' }
  const body = isPlainObject(request.body) ? request.body : {}
  const path = str(request.path)

  const host = header(request.headers, 'x-forwarded-host') || header(request.headers, 'host')
  const appOrigin = host === '' ? '' : `https://${host}`
  const siblingBase = siblingBaseOf(path, appOrigin, DRIVE_PATH)

  const mode = str(body.mode)
  // `resume` carries the id alone, so the row is the only place the implementation
  // can come from; `run` has no row yet, so the body is. A mode this rule does not
  // know plans no fetch and is refused by the gate.
  const row = fieldsOf(rows(data?.steps?.find)[0] ?? {})
  const named = mode === 'run' ? str(body.impl) : mode === 'resume' ? str(row.impl) : ''
  const impl = IMPL_PATTERN.test(named) ? named : ''

  const indexPath = impl === '' ? '' : `/w/${impl}/.bffless/workflows/index.json`
  const hasIndex = impl !== '' && siblingBase !== ''
  return {
    hasIndex,
    indexUrl: hasIndex ? `${siblingBase}${indexPath}` : '',
    indexPath,
    impl,
    siblingBase,
    host,
    appOrigin,
    mode,
    runId: str(body.id),
  }
}
