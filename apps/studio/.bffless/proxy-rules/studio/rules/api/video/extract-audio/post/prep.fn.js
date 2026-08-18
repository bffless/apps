function handler({ request }) {
  var body = (request && request.body) || {}
  // The ffmpeg handler accepts /api/uploads/... serve paths directly as input.
  return {
    input: String(body.sourceUrl || ''),
    projectId: String(body.projectId || ''),
    executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : '',
  }
}
