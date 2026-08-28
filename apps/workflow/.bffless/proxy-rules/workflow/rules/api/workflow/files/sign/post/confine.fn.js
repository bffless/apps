// confine.fn.js — mirrors Studio's uploads/sign/resolvePath.fn.js, narrowed to the harness prefix
function handler({ request, deployment }) {
  var body = (request && request.body) || {}
  var path = typeof body.path === 'string' ? body.path.replace(/^\/+/, '').replace(/^api\/uploads\//, '').split('?')[0] : ''
  var ok = path.indexOf('workflows/') === 0 && path.indexOf('..') === -1 && path.indexOf('//') === -1
  return { ok: ok, notOk: !ok, storagePath: ok ? deployment.owner + '/' + deployment.repo + '/uploads/' + path : '' }
}
