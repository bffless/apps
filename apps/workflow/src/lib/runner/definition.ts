import { loadDefinition } from '@bffless/workflow-lint/lint'
import type { Finding } from '@bffless/workflow-lint/lint'
import type { Definition } from './types'

export interface LoadedWorkflow { def: Definition | null; findings: Finding[]; ok: boolean; yaml: string }
export function loadWorkflow(yamlText: string, file: string): LoadedWorkflow {
  const { def, findings } = loadDefinition(yamlText, { file })
  const ok = def !== null && !findings.some((f) => f.severity === 'error')
  return { def, findings, ok, yaml: yamlText }
}
