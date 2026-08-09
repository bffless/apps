function handler({ request, deployment }) {
  var body = (request && request.body) || {}
  var audioPath = body.audioPath || ''
  // Rebuild the bucket storage path the signer expects from the public serve path.
  var key = String(audioPath).replace(/^\/+/, '')
  key = key.replace(/^api\/uploads\//, '')
  var storagePath = deployment.owner + '/' + deployment.repo + '/uploads/' + key
  var durationSec = typeof body.durationSec === 'number' ? body.durationSec : Number(body.durationSec) || 0
  return { storagePath: storagePath, durationSec: durationSec }
}
