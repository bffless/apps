function handler({ request }) {
  var b = (request && request.body) || {};
  var pid = (b.parentId != null) ? String(b.parentId) : '';
  var name = (b.name != null) ? String(b.name) : '';
  return { parentId: pid, name: name, check: pid !== '' && name !== '' };
}