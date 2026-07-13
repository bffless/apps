function handler({ steps }) {
  var l = (steps && steps.link) || {};
  if (l == null || typeof l !== 'object') l = {};
  var folderId = l.folderId || null;
  var revoked = l.revoked === true || l.revoked === 'true';
  var exp = (l.expiresMs != null) ? Number(l.expiresMs) : null;
  var expired = (exp != null && !isNaN(exp)) ? (Date.now() > exp) : false;
  var valid = !!folderId && !revoked && !expired;
  return { result: { valid: valid, folderId: valid ? folderId : null } };
}