function handler({ steps }) {
  function s(v) { return typeof v === 'string' ? v : ''; }

  var d = (steps && steps.draft) || {};
  var c = d.content != null ? d.content : (d.output != null ? d.output : d);

  // Normalize the model output to a single text string.
  var text = '';
  if (typeof c === 'string') {
    text = c;
  } else if (c && typeof c.prompt === 'string') {
    text = c.prompt;
  } else if (c && typeof c.text === 'string') {
    text = c.text;
  } else if (c && typeof c.length === 'number') {
    for (var i = 0; i < c.length; i++) { text += String(c[i]); }
  } else {
    text = String(c == null ? '' : c);
  }
  text = text.trim();

  // Strip a ```fenced``` block if the model wrapped the prompt in one.
  var fence = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fence) { text = fence[1].trim(); }

  // If the model still returned a JSON object, unwrap its prompt field.
  // (Plain text is the expected path; this is only a safety net.)
  if (text.charAt(0) === '{' && text.charAt(text.length - 1) === '}') {
    try {
      var parsed = JSON.parse(text);
      if (parsed && typeof parsed.prompt === 'string') { text = parsed.prompt; }
    } catch (e) {
      // Not valid JSON (e.g. unescaped quotes) - keep the raw text as-is.
    }
  }

  // JSON.stringify guarantees correct escaping regardless of the content.
  return { promptJson: JSON.stringify({ prompt: s(text) }) };
}