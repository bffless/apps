function handler({ steps }) {
  var c = (steps && steps.clone) || {}
  var out = c.output != null ? c.output : c
  var voiceId = ''
  var previewUrl = ''
  if (typeof out === 'string') {
    voiceId = out
  } else if (out && typeof out === 'object') {
    if (typeof out.voice_id === 'string') { voiceId = out.voice_id }
    else if (typeof out.voiceId === 'string') { voiceId = out.voiceId }
    else if (typeof out.id === 'string') { voiceId = out.id }
    if (typeof out.preview === 'string') { previewUrl = out.preview }
  }
  return { voiceId: voiceId, previewUrl: previewUrl }
}
