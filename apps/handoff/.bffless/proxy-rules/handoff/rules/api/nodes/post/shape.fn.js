function handler({ request, steps }) {
  var r = (steps && steps.register) || {};
  var body = (request && request.body) || {};
  var rawSize = (r.size != null) ? r.size : null;
  var size = (rawSize != null) ? Number(rawSize) : null;
  var rawCreated = (r.createdMs != null) ? r.createdMs : body.createdMs;
  var created = (rawCreated != null) ? Number(rawCreated) : 0;
  return {
    node: {
      id: r.id || r.recordId || r.record_id || null,
      type: r.nodeType || 'file',
      name: r.displayName || body.displayName || r.original_name || r.filename || 'Untitled',
      title: (r.title != null && String(r.title) !== '') ? String(r.title) : null,
      description: (r.description != null && String(r.description) !== '') ? String(r.description) : null,
      mime: r.content_type || r.mime_type || null,
      size: (size != null && !isNaN(size)) ? size : null,
      url: r.url || null,
      storageKey: r.storage_path || body.storageKey || null,
      parentId: r.parentId || body.parentId || 'root',
      ownerId: r.ownerId || null,
      mode: 'inheriting', grants: [],
      createdAt: (created != null && !isNaN(created)) ? created : 0
    }
  };
}