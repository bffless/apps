/**
 * `_meta.ui` for every ui:// resource the endpoint serves (spec 10 §The MCP
 * endpoint; Phase 2 plan, Decision 9): a CSP whose `connectDomains` are the
 * app domain and the storage origin — presigned PUT/GET need direct network,
 * everything else rides the bridge — and whose `resourceDomains` let an
 * `<img>`/`<video>` load a presigned URL. Both are **derived from the
 * instance** at request time (the request's own host; the origin of a
 * `signed_url` step's answer), never written down: the catalog app is
 * instance-agnostic (06).
 */
export interface UiMeta {
  ui: {
    csp: { connectDomains: string[]; resourceDomains: string[] }
    prefersBorder: true
  }
}

export function uiMeta(appOrigin: string, storageOrigin: string): UiMeta {
  const connect = [appOrigin, storageOrigin].filter((origin) => origin !== '')
  const resource = storageOrigin === '' ? [] : [storageOrigin]
  return { ui: { csp: { connectDomains: connect, resourceDomains: resource }, prefersBorder: true } }
}

const ORIGIN = /^(https?:\/\/[^/?#]+)/i

/**
 * `https://storage.googleapis.com` from a presigned URL; `''` when the URL is
 * relative (a local-FS instance without `PUBLIC_ORIGIN`, 06) or unparsable. A
 * regex on purpose: the sandbox's `URL` polyfill knows pathnames only.
 */
export function originOf(url: unknown): string {
  if (typeof url !== 'string') return ''
  const match = url.match(ORIGIN)
  return match ? match[1] : ''
}
