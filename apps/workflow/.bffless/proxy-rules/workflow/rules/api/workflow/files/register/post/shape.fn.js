// Normalize the register_upload result to the spec-02 File ref.
function handler({ steps }) {
  const r = steps.register || {}
  const path = r.storagePath || r.path || r.storageKey || ''
  const name = r.fileName || r.originalName || path.split('/').pop() || 'file'
  const url = '/api/workflow/files/' + path.replace(/^workflows\//, '')
  return { path, name, contentType: r.contentType || 'application/octet-stream', size: r.size || 0, url }
}
