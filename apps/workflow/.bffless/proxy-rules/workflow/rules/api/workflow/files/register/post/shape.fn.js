// Normalize the register_upload result to the spec-02 File ref. CE's handler returns an
// UploadRecordOutput: { id, filename, url, storage_path, content_type, size, original_name }
// where `url` is the publicPath the presigned step minted (/api/uploads/<subDir>/<file>) —
// exactly the serve rule's route, so the ref's url is CE's own and `path` is the
// uploads-relative key that the pipelines and the serve rule share.
function handler({ steps }) {
  const r = steps.register || {}
  const url = typeof r.url === 'string' ? r.url : ''
  const path =
    url.replace(/^\/api\/uploads\//, '') ||
    String(r.storage_path || '').replace(/^.*?\/uploads\//, '')
  const name = r.original_name || r.filename || path.split('/').pop() || 'file'
  return {
    path,
    name,
    contentType: r.content_type || 'application/octet-stream',
    size: typeof r.size === 'number' ? r.size : 0,
    url: url || '/api/uploads/' + path,
  }
}
