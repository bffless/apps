function handler({ steps }) {
  var tts = (steps && steps.tts) || {}
  var out = tts.output != null ? tts.output : tts
  var url = ''
  if (typeof out === 'string') {
    url = out
  } else if (out && typeof out.length === 'number' && out.length) {
    url = String(out[0])
  } else if (out && typeof out.audio === 'string') {
    url = out.audio
  } else if (out && typeof out.url === 'string') {
    url = out.url
  }
  return { url: url }
}
