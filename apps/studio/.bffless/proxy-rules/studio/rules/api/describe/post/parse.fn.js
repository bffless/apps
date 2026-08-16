function handler({ steps }) {
  function str(v) { return typeof v === 'string' ? v : '' }
  var d = (steps && steps.describe) || {}
  // ai_handler (Claude) puts the completion text on .content; the older
  // replicate shape put it on .output (string / string[] / { text }). Read
  // whichever is present so the parser survives a step swap either way.
  var raw = d.content != null ? d.content : (d.output != null ? d.output : d)
  var text = ''
  if (typeof raw === 'string') { text = raw }
  else if (raw && typeof raw.length === 'number') { for (var a = 0; a < raw.length; a++) { text += String(raw[a]) } }
  else if (raw && typeof raw.text === 'string') { text = raw.text }
  var sIdx = text.indexOf('{')
  var eIdx = text.lastIndexOf('}')
  if (sIdx >= 0 && eIdx > sIdx) { text = text.slice(sIdx, eIdx + 1) }
  var parsed = null
  try { parsed = JSON.parse(text) } catch (err) { parsed = null }
  var title = parsed ? str(parsed.title).trim() : ''
  var summary = parsed ? str(parsed.summary).trim() : ''
  if (title.length > 120) { title = title.slice(0, 120) }
  return { descriptionJson: JSON.stringify({ title: title, summary: summary }) }
}
