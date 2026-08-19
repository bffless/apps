import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'
import type { ExprSite } from '../model/slots.js'
import { checkIds } from './ids.js'
import { checkGraph } from './graph.js'
import { checkContexts } from './contexts.js'
import { checkUpstream } from './upstream.js'
import { checkRender } from './render.js'
import { checkPaths } from './paths.js'
import { checkBody } from './body.js'
import { checkHeadless } from './headless.js'
import { checkOutputs } from './outputs.js'

export function runChecks(def: Definition, sites: ExprSite[]): Finding[] {
  return [
    ...checkIds(def),
    ...checkGraph(def),
    ...checkContexts(def, sites),
    ...checkUpstream(def, sites),
    ...checkRender(def),
    ...checkPaths(def),
    ...checkBody(def, sites),
    ...checkHeadless(def, sites),
    ...checkOutputs(def),
  ]
}
