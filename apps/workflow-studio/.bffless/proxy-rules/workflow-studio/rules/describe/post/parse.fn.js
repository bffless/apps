function handler({ steps, stepErrors }) {
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
  // R120: this rule is SYNC - there is no job row to write an error onto, so an
  // unreadable answer becomes an error envelope (`error` + `code`) that the rule
  // returns with a 502 instead of Studio's silently-empty { title: '', summary: '' }.
  // An empty title here would otherwise poison the blog and the cover, which both
  // read it. ce#662 forward-compat: the failed step's code would ride in `code`.
  if (!title && !summary) {
    // R137: the envelope's `code` IS this value - the rule's fail branch emits
    // {{steps.parse.code}} rather than a hard-coded string, so a real CE code survives
    // once ce#662 lands and 'AI_UNREADABLE' is only the fallback when there is none.
    var derr = stepErrors && stepErrors.describe
    var dcode = (derr && typeof derr.code === 'string' && derr.code) ? derr.code : 'AI_UNREADABLE'
    return {
      ok: false,
      notOk: true,
      code: dcode,
      error: 'The AI description writer did not return a usable title and summary - it may be temporarily overloaded. Please try again.',
      descriptionJson: '',
    }
  }
  return {
    ok: true,
    notOk: false,
    code: '',
    error: '',
    descriptionJson: JSON.stringify({ title: title, summary: summary }),
  }
}
