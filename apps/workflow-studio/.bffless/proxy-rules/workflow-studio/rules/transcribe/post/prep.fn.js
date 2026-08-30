function handler({ request, deployment }) {
  var body = (request && request.body) || {}

  // R129 path confinement (copied verbatim into every prep.fn.js - function_handler
  // files cannot import).
  function safe(v) {
    if (typeof v !== 'string') return ''
    // Same steps, same order as the harness's files/sign/post/confine.fn.js (apps#466):
    // strip leading slashes, an `api/uploads/` prefix and any `?query`, then refuse
    // `..`, `//` and anything not anchored at `workflows/`. The trailing-slash strip is
    // this app's own, so an outPrefix comes back normalised.
    var p = v.replace(/^\/+/, '').replace(/^api\/uploads\//, '').split('?')[0].replace(/\/+$/, '')
    if (!p) return ''
    if (p.indexOf('..') >= 0) return ''
    if (p.indexOf('//') >= 0) return ''
    if (p.indexOf('workflows/') !== 0) return ''
    return p
  }
  var REFUSAL = 'Refused - every path must be an uploads-relative path under workflows/'

  // The workflow sends `audio` as the uploads-relative path the extract step returned
  // (Studio's rule took an /api/uploads/ URL). The signer wants the storage path.
  var key = safe(body.audio)
  if (!key) return { ok: false, notOk: true, error: REFUSAL, storagePath: '', diarize: false, language: null }

  // The spoken language, as WhisperX's `language` input: an ISO 639 code pins it, `null`
  // asks the model to detect it from the first 30 s. Detection is not safe to rely on -
  // a UK-accented English talk came back as Welsh (cy, 0.91), WhisperX has no Welsh
  // alignment model, so the whole transcript arrived without a single word timing and
  // the run died two jobs later as "no spoken audio". The kickoff form's `language`
  // choice defaults to `en`; its `auto` option (and an absent/blank field, for API
  // callers) is the model's own default. Anything else is refused up front - it would
  // otherwise reach `whisperx.load_model` verbatim.
  var LANGUAGE_REFUSAL = 'Refused - language must be an ISO 639 code such as en, or auto'
  var language = null
  if (body.language != null && body.language !== '') {
    var lang = String(body.language).trim().toLowerCase()
    if (lang !== 'auto') {
      if (!/^[a-z]{2,3}$/.test(lang)) {
        return { ok: false, notOk: true, error: LANGUAGE_REFUSAL, storagePath: '', diarize: false, language: null }
      }
      language = lang
    }
  }

  return {
    ok: true,
    notOk: false,
    error: '',
    storagePath: deployment.owner + '/' + deployment.repo + '/uploads/' + key,
    diarize: body.diarize === true,
    language: language,
  }
}
