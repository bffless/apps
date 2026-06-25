/**
 * RTK Query data layer for the Handoff `/api/*` endpoints. Network calls go
 * through here for consistent caching, in-flight state, and error handling.
 * Endpoints are added as feature slices land (#7+).
 */

import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'

export const handoffApi = createApi({
  reducerPath: 'handoffApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/', credentials: 'include' }),
  endpoints: () => ({}),
})
