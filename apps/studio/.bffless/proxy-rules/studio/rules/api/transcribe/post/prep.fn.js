function handler({ request, deployment }) {
  var body = (request && request.body) || {}
  var audioUrl = body.audioUrl || ''
  // Rebuild the bucket storage path the signer expects from the public serve path.
  var key = String(audioUrl).replace(/^\/+/, '')
  key = key.replace(/^api\/uploads\//, '')
  var storagePath = deployment.owner + '/' + deployment.repo + '/uploads/' + key
  return { storagePath: storagePath, diarize: body.diarize === true }
}
