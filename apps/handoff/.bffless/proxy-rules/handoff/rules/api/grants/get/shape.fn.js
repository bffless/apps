function handler({ steps }) {
  var folder = (steps && steps.folder) || {};
  var existing = folder.grantsJson;
  if (typeof existing === 'string') {
    try { existing = JSON.parse(existing); } catch (e) { existing = []; }
  }
  if (!existing || Object.prototype.toString.call(existing) !== '[object Array]') {
    existing = [];
  }
  var out = [];
  for (var i = 0; i < existing.length; i++) {
    var g = existing[i] || {};
    if (g.principalId) {
      out.push({ principalId: g.principalId, principalEmail: g.principalEmail || null, level: (g.level === 'edit') ? 'edit' : 'view' });
    }
  }
  return { grants: out };
}