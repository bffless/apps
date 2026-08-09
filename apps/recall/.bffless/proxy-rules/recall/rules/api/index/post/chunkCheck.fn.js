// Gates whether the postSteps' texts/embed/zip steps run (condition:
// steps.chunkCheck.ok). `chunk` itself is conditioned on steps.gate.ok, so if
// the sync gate rejected the request, steps.chunk never ran and is null here
// -- ok naturally comes out false with no need to re-check steps.gate.
function handler({ steps }) {
  var c = (steps && steps.chunk) || null
  var ok = !!(c && !c.error && typeof c.count === 'number' && c.count > 0)
  return { ok: ok, notOk: !ok }
}
