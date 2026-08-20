/**
 * `/:impl/:workflow` resolved against discovery.
 *
 * The route carries the workflow *id* (R1) but every fetch needs the listing's
 * `file`, so the id → file mapping lives here once and every screen below the
 * route agrees on it — including which implementation the alias names.
 */
import { useParams } from 'react-router-dom'
import { workflowId } from '../lib/coerce'
import type { Implementation, WorkflowListing } from '../lib/coerce'
import { useDiscoverQuery } from './workflowApi'

export interface ResolvedWorkflow {
  /** The implementation the `:impl` alias names, once discovery has answered. */
  impl?: Implementation
  /** The listing `:workflow` names — absent for `/:impl`, or for an unknown id. */
  listing?: WorkflowListing
  isLoading: boolean
  /** Discovery failed — the alias is unresolved, not unknown (08). */
  isError: boolean
  error?: unknown
}

export function useWorkflowListing(): ResolvedWorkflow {
  const { impl: alias, workflow } = useParams()
  const { data, isLoading, isError, error } = useDiscoverQuery()

  const impl = data?.find((candidate) => candidate.alias === alias)
  const listing = workflow
    ? impl?.workflows.find((candidate) => workflowId(candidate.file) === workflow)
    : undefined

  return { impl, listing, isLoading, isError, error }
}
