// Fixtures under test/fixtures/ are live records from workflow.j5s.dev, read as workflow-ci,
// and slimmed with this script: `node slim.mjs <raw.json> <out.json>`
//
// Slim a harness run record for use as a test fixture: drop the embedded definition/yaml,
// truncate bulky word arrays and text, keep only the `last` poll response (where CE's
// job result lives). Shapes stay real; only volume goes.
import fs from 'node:fs'
const [inp, out] = process.argv.slice(2)
const rec = JSON.parse(fs.readFileSync(inp, 'utf8'))
const run = { ...rec.run }
delete run.definition; delete run.yaml
const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s)
const steps = rec.steps.map((s) => {
  const o = { ...s }
  delete o.inputs; delete o.summary; delete o.annotations; delete o.heartbeatAt
  if (/^sheets\/\d+\/sheets$/.test(o.key) && o.response && typeof o.response === 'object' && 'last' in o.response) o.response = { last: o.response.last }; else delete o.response
  if (o.outputs && typeof o.outputs === 'object') {
    const outs = { ...o.outputs }
    for (const k of Object.keys(outs)) {
      const v = outs[k]
      if (Array.isArray(v) && v.length > 5 && k !== 'sheets' && k !== 'frames') outs[k] = v.slice(0, 5)
      else if (typeof v === 'string') outs[k] = cut(v, 200)
    }
    o.outputs = outs
  }
  return o
})
fs.writeFileSync(out, JSON.stringify({ run, steps }, null, 2) + '\n')
console.log(out, fs.statSync(out).size, 'bytes', steps.length, 'steps')
