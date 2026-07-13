function handler({ request, steps }) {
  var r = (steps && steps.create) || {};
  var body = (request && request.body) || {};
  var build = (steps && steps.build) || {};
  var id = r.id || r.recordId || r.record_id || null;
  var entry = r.siteEntry || build.entry || body.entry || 'index.html';
  var created = (r.createdMs != null) ? Number(r.createdMs) : (body.createdMs != null ? Number(body.createdMs) : 0);
  var url = r.url || build.url || null;
  return {
    node: {
      id: id, type: r.nodeType || 'site',
      name: r.displayName || body.name || 'Untitled site',
      mime: null, size: null, url: url, storageKey: null,
      path: build.path || null,
      parentId: r.parentId || body.parentId || 'root',
      ownerId: r.ownerId || null,
      mode: r.mode || 'inheriting', grants: [],
      siteEntry: entry,
      createdAt: (created != null && !isNaN(created)) ? created : 0
    }
  };
}