/**
 * A workflow's id from its file name — `interactive.workflow.yaml` →
 * `interactive`, `long-to-short.yaml` → `long-to-short` — the page's
 * `workflowId` (`lib/coerce.ts`) restated, because the bundle may not import
 * that module (the fence) and `ids.test.ts` holds the two equal.
 */
export function workflowId(file: string): string {
  const base = file.split('/').pop() ?? file
  return base.replace(/\.workflow\.ya?ml$/i, '').replace(/\.ya?ml$/i, '')
}
