/**
 * RTK Query data layer for Recall's `/api/*` endpoints. Every network call the
 * app makes goes through here so caching, in-flight state, and error handling
 * are consistent. Endpoints are injected by later tasks — this file owns only
 * the base query.
 */

import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query/react'
import { attemptRefresh } from '../lib/auth'

const rawBaseQuery = fetchBaseQuery({ baseUrl: '/', credentials: 'include' })

/**
 * On a 401 (expired SuperTokens access token) run the shared single-flight
 * refresh and retry the request once. The refresh is shared with
 * `fetchWithReauth` so the whole app issues exactly one refresh per expiry — the
 * refresh token rotates, so concurrent refreshes would race (see `attemptRefresh`).
 */
const baseQueryWithReauth: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
  args,
  api,
  extraOptions,
) => {
  let result = await rawBaseQuery(args, api, extraOptions)
  if (result.error?.status === 401 && (await attemptRefresh())) {
    result = await rawBaseQuery(args, api, extraOptions)
  }
  return result
}

export const recallApi = createApi({
  reducerPath: 'recallApi',
  baseQuery: baseQueryWithReauth,
  tagTypes: ['Videos'],
  endpoints: () => ({}),
})
