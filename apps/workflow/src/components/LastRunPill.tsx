/**
 * The status of a workflow's most recent run, or nothing when it has never run.
 *
 * A component rather than a helper because it owns one `useListRunsQuery` — a
 * list of workflows renders one of these per row, which keeps the hook count
 * per component fixed while still asking per workflow.
 */
import { useListRunsQuery } from '../store/workflowApi'
import { StatusGlyph, StatusPill } from './StatusPill'

export function LastRunPill({
  impl,
  workflow,
  glyphOnly = false,
}: {
  impl: string
  workflow: string
  /** The 15px glyph alone — the rail has no room for the word. */
  glyphOnly?: boolean
}) {
  // Rows arrive newest-first (workflowApi sorts on startedAt).
  const { data } = useListRunsQuery({ impl, workflow })
  const latest = data?.[0]
  if (!latest) return glyphOnly ? <StatusGlyph status="queued" /> : null
  return glyphOnly ? <StatusGlyph status={latest.status} /> : <StatusPill status={latest.status} />
}
