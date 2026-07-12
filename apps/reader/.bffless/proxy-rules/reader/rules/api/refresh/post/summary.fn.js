function handler({ steps }) {
  var up = (steps && steps.upsert) || {}
  function n(v) { return (typeof v === 'number' && !isNaN(v)) ? v : 0 }
  return {
    inserted: n(up.inserted),
    skipped: n(up.skipped),
    errors: n(up.errored)
  }
}
