// Adds a `root: {id, public}` meta object to the GET /api/nodes listing
// response (effective Public/Private UI). The `shape` step already loads
// all folder/root records into `folders`; this appends a lookup for the
// `nodeType==='root'` record and computes `public` from its grantsJson.
// Idempotent (marker: `rootMeta`); exits non-zero on missing anchors.
import { readFileSync, writeFileSync } from 'node:fs'

const P = new URL('../handoff.proxy-rules.json', import.meta.url)
const doc = JSON.parse(readFileSync(P, 'utf8'))

const rule = doc.rules.find((r) => r.pathPattern === '/api/nodes' && r.method === 'GET')
if (!rule) {
  console.error('GET /api/nodes rule not found')
  process.exit(1)
}

const shapeStep = rule.pipelineConfig.steps.find((s) => s.id === 'shape')
const responseStep = rule.pipelineConfig.steps.find((s) => s.id === 'response')
if (!shapeStep || !responseStep) {
  console.error('shape or response step not found on GET /api/nodes rule')
  process.exit(1)
}

const SHAPE_OLD = 'return { nodes: out }; }'
const SHAPE_NEW =
  "var rootRec=null;for(var ri=0;ri<folders.length;ri++){if((folders[ri]||{}).nodeType==='root'){rootRec=folders[ri];break;}} var rootId=null;var rootPublic=false; if(rootRec){rootId=rootRec.id||rootRec.recordId||rootRec.record_id||null; var rg=rootRec.grantsJson; if(typeof rg==='string'){try{rg=JSON.parse(rg);}catch(e){rg=[];}} if(rg&&Object.prototype.toString.call(rg)==='[object Array]'){for(var gi=0;gi<rg.length;gi++){if((rg[gi]||{}).principalId==='anyone'){rootPublic=true;break;}}}} return { nodes: out, rootMeta: { id: rootId, public: rootPublic } }; }"

const RESPONSE_OLD = '{"nodes": {{{steps.shape.nodes}}}}'
const RESPONSE_NEW = '{"nodes": {{{steps.shape.nodes}}}, "root": {{{steps.shape.rootMeta}}}}'

let changed = false

if (shapeStep.config.code.includes('rootMeta')) {
  console.log('shape step already carries rootMeta — nothing to do')
} else {
  if (!shapeStep.config.code.includes(SHAPE_OLD)) {
    console.error('shape step anchor not found — inspect the step body')
    process.exit(1)
  }
  shapeStep.config.code = shapeStep.config.code.replace(SHAPE_OLD, SHAPE_NEW)
  changed = true
  console.log('shape step: rootMeta computation appended')
}

if (responseStep.config.body === RESPONSE_NEW) {
  console.log('response step already carries root meta — nothing to do')
} else {
  if (responseStep.config.body !== RESPONSE_OLD) {
    console.error('response step body anchor not found — inspect the step body')
    process.exit(1)
  }
  responseStep.config.body = RESPONSE_NEW
  changed = true
  console.log('response step: body now includes "root"')
}

if (changed) {
  writeFileSync(P, JSON.stringify(doc, null, 2) + '\n')
  console.log('handoff.proxy-rules.json updated')
} else {
  console.log('nothing to do — both patches already present')
}
