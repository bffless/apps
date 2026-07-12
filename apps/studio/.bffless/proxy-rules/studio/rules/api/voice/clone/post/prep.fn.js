function handler({ request, deployment }) {
  var body = (request && request.body) || {}
  var sampleUrl = body.sampleUrl || ''
  // Rebuild the bucket storage path from the public serve path (mirrors
  // /api/transcribe resolvePath) so the signer can mint a download URL.
  var key = String(sampleUrl).replace(/^\/+/, '')
  key = key.replace(/^api\/uploads\//, '')
  var storagePath = deployment.owner + '/' + deployment.repo + '/uploads/' + key
  // Preset fallback id, only used if the clone step is ever disabled again.
  return { sampleUrl: sampleUrl, storagePath: storagePath, voiceId: 'Friendly_Person' }
}
