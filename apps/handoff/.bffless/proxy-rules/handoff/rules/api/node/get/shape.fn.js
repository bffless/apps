function handler({ steps }) {
  var r = (steps && steps.query) || {};
  var UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  var folders = (steps && steps.allFolders) || [];
  var byId = {};
  for (var a = 0; a < folders.length; a++) { var f = folders[a] || {}; var fid = f.id || f.recordId || f.record_id; if (fid) byId[fid] = f; }
  function folderPath(startId) { var names = []; var cur = String(startId || ''); var g = 0; while (cur && UUID.test(cur) && byId[cur] && g < 64) { names.push(String(byId[cur].displayName || 'Untitled')); cur = byId[cur].parentId || ''; g++; } var out = []; for (var b = names.length - 1; b >= 0; b--) out.push(names[b]); return out.join('/'); }
  var CONTENT = '/api/uploads/content/';
  var SPM = '/uploads/content/';
  if (r == null || typeof r !== 'object') r = {};
  var id = r.id || r.recordId || r.record_id || null;
  var t = r.nodeType || 'file';
  var entry = r.siteEntry || 'index.html';
  var size = (typeof r.size === 'number') ? r.size : (r.size != null ? Number(r.size) : null);
  var created = (typeof r.createdMs === 'number') ? r.createdMs : (r.createdMs != null ? Number(r.createdMs) : 0);
  var url = r.url || null;
  var grants = r.grantsJson;
  if (typeof grants === 'string') { try { grants = JSON.parse(grants); } catch (e) { grants = []; } }
  if (!grants || Object.prototype.toString.call(grants) !== '[object Array]') { grants = []; }
  var sp = r.storage_path || '';
  var mi = sp.indexOf(SPM);
  var nonFolderPath = (mi >= 0) ? sp.slice(mi + SPM.length) : ((url && url.indexOf(CONTENT) === 0) ? url.slice(CONTENT.length) : null);
  var node = id ? {
    id: id, type: t,
    name: r.displayName || r.original_name || r.filename || 'Untitled',
    title: (r.title != null && String(r.title) !== '') ? String(r.title) : null,
    description: (r.description != null && String(r.description) !== '') ? String(r.description) : null,
    mime: r.content_type || r.mime_type || null,
    size: (size != null && !isNaN(size)) ? size : null,
    url: url, storageKey: r.storage_path || null,
    path: (t === 'folder') ? folderPath(id) : nonFolderPath,
    parentId: r.parentId || 'root',
    ownerId: r.ownerId || null,
    mode: r.mode || 'inheriting',
    feedExcluded: (r.feedExcluded === true || r.feedExcluded === 'true'),
    grants: grants,
    createdAt: (created != null && !isNaN(created)) ? created : 0
  } : null;
  return { node: node };
}