function handler({ steps }) {
  // Did the with-audio refiner come back with anything? A failed post-step has
  // its output dropped by the executor, so an empty `steps.refiner` means the
  // Replicate/Gemini call died — most often because the provider's audio input
  // is unavailable (the Gemini Files API upload fails in ~1s, independent of
  // file size, model or scene length). Everything ELSE in the request still
  // works, so rather than surfacing an error we re-run deaf: same prompt, same
  // dense contact sheets, same word timings and measured dead space, minus the
  // one input the provider can't take right now.
  var d = (steps && steps.refiner) || {}
  var missing = !d || (d.status == null && d.output == null)
  return { needsFallback: missing, heardAudio: !missing }
}
