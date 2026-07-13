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
  var level = (body.level === 'edit') ? 'edit' : 'view';
  var email = body.principalEmail ? String(body.principalEmail) : null;
  if (pid === 'anyone') { level = 'view'; email = null; }
  var out = [];
  var replaced = false;
  for (var i = 0; i < existing.length; i++) {
    var g = existing[i] || {};
    if (g.principalId === pid && pid) {
      out.push({ principalId: pid, principalEmail: (pid === 'anyone') ? null : (email || g.principalEmail || null), level: level });
      replaced = true;
    } else if (g.principalId) {
      out.push({ principalId: g.principalId, principalEmail: g.principalEmail || null, level: (g.level === 'edit') ? 'edit' : 'view' });
    }
  }
  if (pid && !replaced) {
    out.push({ principalId: pid, principalEmail: email, level: level });
  }
  return { allowed: true, denied: false, grants: out, canSave: !!eff };
}