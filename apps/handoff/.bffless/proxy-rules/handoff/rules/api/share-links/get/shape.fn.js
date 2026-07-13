function handler({ steps }) {
  var rows = (steps && steps.rows) || [];
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var l = rows[i] || {};
    var token = l.id || l.recordId || l.record_id || null;
    if (!token) continue;
    var revoked = l.revoked === true || l.revoked === 'true';
    var exp = (l.expiresMs != null) ? Number(l.expiresMs) : null;
    out.push({
      token: token,
      folderId: l.folderId || null,
      expiresAt: (exp != null && !isNaN(exp)) ? exp : null,
      revoked: revoked,
      url: '/s/' + token,
      createdAt: (l.createdMs != null) ? Number(l.createdMs) : 0
    });
  }
  return { links: out };
}