function handler({ request, steps }) {
  var r = (steps && steps.create) || {};
  var body = (request && request.body) || {};
  var created = (r.createdMs != null) ? Number(r.createdMs) : (body.createdMs != null ? Number(body.createdMs) : 0);
  return {
    node: {
      id: r.id || r.recordId || r.record_id || null,
      type: r.nodeType || 'folder',
      name: r.displayName || body.name || 'Untitled folder',
      mime: null, size: null, url: null, storageKey: null,
      parentId: r.parentId || body.parentId || 'root',
      ownerId: r.ownerId || null,
      mode: r.mode || 'inheriting',
      grants: [],
      createdAt: (created != null && !isNaN(created)) ? created : 0
    }
  };
}