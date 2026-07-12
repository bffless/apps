function handler({ steps }) {
  var d = (steps && steps.blog) || {}
  if (!d || (d.status == null && d.output == null)) {
    return { ok: false, notOk: true, error: 'The AI writer did not return a result — it may be temporarily overloaded, or the video may be too long. Please try again.', data: { markdown: '' } }
  }

  var raw = d.output != null ? d.output : d
  var text = ''
  if (typeof raw === 'string') {
    text = raw
  } else if (raw && typeof raw.length === 'number') {
    for (var a = 0; a < raw.length; a++) {
      text += String(raw[a])
    }
  } else if (raw && typeof raw.text === 'string') {
    text = raw.text
  }

  // Tolerantly extract the "markdown" string even when the model truncated
  // mid-document: read from the opening quote to the closing unescaped quote, or
  // to the end of the text if it never closed (keep the completed portion).
  function extractMarkdown(s) {
    var ki = s.indexOf('"markdown"')
    if (ki < 0) return ''
    var ci = s.indexOf(':', ki)
    if (ci < 0) return ''
    var qi = s.indexOf('"', ci + 1)
    if (qi < 0) return ''
    var body = ''
    var esc = false
    for (var i = qi + 1; i < s.length; i++) {
      var ch = s.charAt(i)
      if (esc) { body += '\\' + ch; esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') { break }
      body += ch
    }
    // A trailing lone backslash (esc still open at truncation) was dropped above.
    var attempts = [body, body.replace(/\\u[0-9a-fA-F]{0,3}$/, '')]
    for (var t = 0; t < attempts.length; t++) {
      try { return JSON.parse('"' + attempts[t] + '"') } catch (e) {}
    }
    // Last resort: unescape the common sequences by hand so literal newlines or a
    // stray escape can't lose the whole post.
    return body.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }

  var markdown = ''
  var sIdx = text.indexOf('{')
  var eIdx = text.lastIndexOf('}')
  var parsed = null
  if (sIdx >= 0 && eIdx > sIdx) {
    try { parsed = JSON.parse(text.slice(sIdx, eIdx + 1)) } catch (e) { parsed = null }
  }
  if (parsed && typeof parsed.markdown === 'string') {
    markdown = parsed.markdown
  } else {
    markdown = extractMarkdown(text)
  }
  // The model may have returned bare Markdown with no JSON envelope at all.
  if (!markdown && text && text.indexOf('"markdown"') < 0) {
    markdown = text
  }

  markdown = (typeof markdown === 'string') ? markdown.replace(/\s+$/, '') : ''
  if (!markdown) {
    var snippet = (typeof text === 'string') ? text.slice(0, 280).trim() : ''
    var emsg = snippet
      ? 'The AI writer response could not be read. Please try again. Model said: ' + snippet
      : 'The AI writer returned an empty response — it may be temporarily overloaded. Please try again.'
    return { ok: false, notOk: true, error: emsg, data: { markdown: '' } }
  }

  return { ok: true, notOk: false, error: '', data: { markdown: markdown } }
}
