function handler({ steps, stepErrors }) {
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
    // Studio's `String(c)` here turned an EMPTY step - both `.content` and `.output`
    // absent, which is what a failed or skipped step looks like once the executor has
    // dropped its output - into the literal string '[object Object]', i.e. a "prompt"
    // the renderer would happily draw. An unreadable shape is no answer at all, so it
    // degrades to '' and the R120 error envelope below reports it.
    text = (typeof c === 'number' || typeof c === 'boolean') ? String(c) : '';
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

  // R120: this rule is SYNC - there is no job row to write an error onto, so an empty
  // answer becomes an error envelope (`error` + `code`) the rule returns with a 502
  // rather than an empty prompt the renderer would happily draw from. ce#662
  // forward-compat: the failed step's code would ride in `code`.
  if (!text) {
    // R137: the envelope's `code` IS this value - the rule's fail branch emits
    // {{steps.parse.code}} rather than a hard-coded string, so a real CE code survives
    // once ce#662 lands and 'AI_UNREADABLE' is only the fallback when there is none.
    var err = stepErrors && stepErrors.draft;
    var code = (err && typeof err.code === 'string' && err.code) ? err.code : 'AI_UNREADABLE';
    return {
      ok: false,
      notOk: true,
      code: code,
      error: 'The AI thumbnail writer did not return a prompt - it may be temporarily overloaded. Please try again.',
      promptJson: '',
    };
  }

  // JSON.stringify guarantees correct escaping regardless of the content.
  return { ok: true, notOk: false, code: '', error: '', promptJson: JSON.stringify({ prompt: s(text) }) };
}
