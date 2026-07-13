function handler({ user, request, steps }) {
  var folder = (steps && steps.folder) || {};
  var body = (request && request.body) || {};
  var uid = (user && user.id) || null;
  var isAdmin = !!user && user.role === 'admin';
  var isOwner = !!uid && folder.ownerId === uid;
  var eff = (steps && steps.resolveRootShape && steps.resolveRootShape.effectiveFolderId) || null;
  if (!isAdmin && !isOwner) {
    return { allowed: false, denied: true, grants: [], canSave: false };
  }
  var existing = folder.grantsJson;
  if (typeof existing === 'string') {
    try { existing = JSON.parse(existing); } catch (e) { existing = []; }
  }
  if (!existing || Object.prototype.toString.call(existing) !== '[object Array]') {
    existing = [];
  }
  var pid = String(body.principalId || '').trim();
  var out = [];
  for (var i = 0; i < existing.length; i++) {
    var g = existing[i] || {};
    if (g.principalId && g.principalId !== pid) {
      out.push({ principalId: g.principalId, principalEmail: g.principalEmail || null, level: (g.level === 'edit') ? 'edit' : 'view' });
    }
  }
  return { allowed: true, denied: false, grants: out, canSave: !!eff };
}