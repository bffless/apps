function handler({ request, steps }) {
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
  var body = (request && request.body) || {}
  var text = typeof body.text === 'string' ? body.text : ''
  var trimmed = text.replace(/^\s+|\s+$/g, '')
  var words = trimmed ? trimmed.split(/\s+/).length : 0
  var durationSeconds = Math.max(1, Math.round(words / 2.5))
  return { audioUrl: url, durationSeconds: durationSeconds }
}
