import type { Finding } from '../findings.js'
import type { Definition } from '../model/definition.js'
import type { ExprSite } from '../model/slots.js'
import { checkIds } from './ids.js'
import { checkGraph } from './graph.js'
import { checkNeedsIf } from './needsif.js'
import { checkContexts } from './contexts.js'
import { checkUpstream } from './upstream.js'
import { checkRender } from './render.js'
import { checkImages } from './images.js'
import { checkFormat } from './format.js'
import { checkSrcs } from './srcs.js'
import { checkToolNames } from './toolnames.js'
import { checkPaths } from './paths.js'
import { checkBody } from './body.js'
import { checkHeadless } from './headless.js'
import { checkOutputs } from './outputs.js'
import { checkRules } from './rules.js'
import type { RuleSetContext } from '../rules/match.js'

export function runChecks(def: Definition, sites: ExprSite[], rules?: RuleSetContext): Finding[] {
  return [
    ...checkIds(def),
    ...checkGraph(def),
    ...checkNeedsIf(def, sites),
    ...checkContexts(def, sites),
    ...checkUpstream(def, sites),
    ...checkRender(def),
    ...checkImages(def),
    ...checkFormat(def),
    ...checkSrcs(def),
    ...checkToolNames(def),
    ...checkPaths(def),
    ...checkBody(def, sites),
    ...checkHeadless(def, sites),
    ...checkOutputs(def),
    ...checkRules(def, rules),
  ]
}
