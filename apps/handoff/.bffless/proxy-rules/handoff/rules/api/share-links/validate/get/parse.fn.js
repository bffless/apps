function handler({ request }) {
  var q = (request && request.query) || {};
  var token = String(q.token || '');
  var isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(token);
  return { token: token, hasToken: isUuid };
}