function handler({ request, steps }) {
  var c = (steps && steps.create) || {};
  var body = (request && request.body) || {};
  var token = c.id || c.recordId || c.record_id || null;
  var exp = (body.expiresMs != null) ? Number(body.expiresMs) : null;
  return {
    link: {
      token: token,
      folderId: body.folderId || null,
      expiresAt: (exp != null && !isNaN(exp)) ? exp : null,
      revoked: false,
      url: token ? ('/s/' + token) : null
    }
  };
}