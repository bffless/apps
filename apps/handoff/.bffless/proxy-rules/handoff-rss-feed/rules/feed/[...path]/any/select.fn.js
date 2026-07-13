function handler({ request, steps }) {
  var UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  function rank(l){return l==='owner'?3:l==='edit'?2:l==='view'?1:0;}
  function evalAccess(ch,vw){ if(vw.isAdmin)return 'owner'; if(vw.userId){for(var i=0;i<ch.length;i++){if(ch[i].ownerId===vw.userId)return 'owner';}} var s=0;for(var k=ch.length-1;k>=0;k--){if(ch[k].mode==='restricted'){s=k;break;}} var best='none';for(var d=s;d<ch.length;d++){var gs=ch[d].grants||[];for(var e=0;e<gs.length;e++){var g=gs[e]||{};if(g.principalId==='anyone'){if(rank('view')>rank(best))best='view';}else if(vw.userId&&g.principalId===vw.userId&&rank(g.level)>rank(best))best=g.level;}} if(!vw.userId&&vw.shareLinkFolderId){var inC=false;for(var j=0;j<ch.length;j++){if(ch[j].id===vw.shareLinkFolderId){inC=true;break;}}if(inC&&rank('view')>rank(best))best='view';} return best; }
  function folderChain(folders,startId){ var byId={};var rootId='';for(var a=0;a<folders.length;a++){var f=folders[a]||{};var id=f.id||f.recordId||f.record_id;if(id){byId[id]=f;if(f.nodeType==='root')rootId=id;}} var rev=[];var cur=(String(startId||'')==='root'&&rootId)?rootId:String(startId||'');var g=0; while(cur&&UUID.test(cur)&&byId[cur]&&g<64){var n=byId[cur];var gr=n.grantsJson;if(typeof gr==='string'){try{gr=JSON.parse(gr);}catch(e){gr=[];}}if(!gr||Object.prototype.toString.call(gr)!=='[object Array]')gr=[];rev.push({id:cur,ownerId:n.ownerId||null,grants:gr,mode:n.mode==='restricted'?'restricted':'inheriting'});cur=(n.parentId==='root'&&rootId)?rootId:(n.parentId||'');g++;} var ch=[];for(var b=rev.length-1;b>=0;b--)ch.push(rev[b]);return ch; }

  // data_query rows are frozen; read the id without mutating the row.
  function idOf(n) { return (n && (n.id || n.recordId || n.record_id)) || null; }

  var nodes = (steps && steps.allNodes) || [];
  // Viewer: a tokenless public feed is evaluated as the anonymous public, so a
  // Restricted-private descendant drops out. A private feed carries a Share
  // Link ?token= (#189 / ADR-0008) — validate it (folder-scoped, not revoked,
  // not expired) and evaluate access as that share-link viewer so the folder +
  // its subtree surface. An invalid/expired/revoked token falls back to the
  // anonymous public (a private folder then 404s — no existence leak).
  var token = String((steps && steps.parse && steps.parse.token) || '');
  var link = (steps && steps.link) || {};
  if (link == null || typeof link !== 'object') link = {};
  var linkFolderId = link.folderId || null;
  var revoked = link.revoked === true || link.revoked === 'true';
  var exp = (link.expiresMs != null) ? Number(link.expiresMs) : null;
  var expired = (exp != null && !isNaN(exp)) ? (Date.now() > exp) : false;
  var tokenOk = !!token && !!linkFolderId && !revoked && !expired;
  var viewer = tokenOk ? { shareLinkFolderId: linkFolderId } : {};
  // Threaded into every item link + enclosure (and the self href) so a reader
  // fetches the feed and its media with the same bearer token.
  var tokenQs = tokenOk ? ('?token=' + token) : '';

  // Pass 1: index by id and find the root record id.
  var byId = {};
  var rootId = '';
  for (var a = 0; a < nodes.length; a++) {
    var n0 = nodes[a] || {};
    var id0 = idOf(n0);
    if (!id0) continue;
    byId[id0] = n0;
    if (n0.nodeType === 'root') rootId = id0;
  }
  var rootKey = rootId || 'root';

  // Pass 2: children by NORMALIZED parent — top-level nodes reference the root
  // as either the 'root' sentinel or the root record's id; unify both to rootKey.
  var childrenByParent = {};
  for (var b = 0; b < nodes.length; b++) {
    var n = nodes[b] || {};
    var id = idOf(n);
    if (!id) continue;
    if (id === rootId) continue;
    var pid = n.parentId || 'root';
    if (pid === 'root' || pid === rootId) pid = rootKey;
    (childrenByParent[pid] = childrenByParent[pid] || []).push(n);
  }

  // Verbatim content path (display-name chain; the root record is excluded — a
  // top-level node's path is just its own name).
  // Verbatim content path = the leaf's storage_path minus the uploads-content
  // prefix -- the SAME key /api/resolve and the content serve use. NOT rebuilt
  // from displayName: displayName is a human label (e.g. an API-set title) and
  // can differ from the stored filename, which 404s the link + media URL.
  function contentPath(n) {
    var sp = String((n && n.storage_path) || '');
    var marker = '/uploads/content/';
    var i = sp.indexOf(marker);
    return i >= 0 ? sp.slice(i + marker.length) : '';
  }

  var segs = (steps && steps.parse && steps.parse.segments) || [];
  var isRoot = !!(steps && steps.parse && steps.parse.isRoot);
  var bad = !!(steps && steps.parse && steps.parse.bad);

  // Resolve the target folder by name-walk from the root (folders only).
  var targetId = null;
  var targetName = 'My Files';
  if (!bad && !isRoot) {
    var curParent = rootKey;
    var found = null;
    var ok = true;
    for (var i = 0; i < segs.length; i++) {
      var kids = childrenByParent[curParent] || [];
      var match = null;
      for (var c = 0; c < kids.length; c++) {
        var kk = kids[c];
        if (kk.nodeType === 'folder' && String(kk.displayName || '') === segs[i]) { match = kk; break; }
      }
      if (!match) { ok = false; break; }
      found = match;
      curParent = idOf(match);
    }
    if (ok && found) {
      targetId = idOf(found);
      targetName = String(found.displayName || 'Untitled');
    }
  } else if (isRoot && !bad) {
    targetId = rootKey;
    targetName = 'My Files';
  }

  var resolvedKey = targetId;

  // Not resolvable, or not publicly viewable -> 404 (no existence leak; a
  // private feed needs a token, added in #189).
  var publicOk = false;
  if (resolvedKey) {
    publicOk = evalAccess(folderChain(nodes, resolvedKey), viewer) !== 'none';
  }
  if (!resolvedKey || !publicOk) {
    return { found: false, notfound: true, xml: '' };
  }

  // Flatten the subtree to publicly-viewable leaves.
  // A feedExcluded folder (#191 / ADR-0007) keeps its whole subtree out of
  // every feed — its own included — while staying browsable. Rides the walk.
  function isExcluded(n) { return !!n && (n.feedExcluded === true || n.feedExcluded === 'true'); }
  var queue = isExcluded(byId[resolvedKey]) ? [] : [resolvedKey];
  var leaves = [];
  var guard = 0;
  while (queue.length && guard < 100000) {
    guard++;
    var pk = queue.shift();
    var kids2 = childrenByParent[pk] || [];
    for (var qi = 0; qi < kids2.length; qi++) {
      var kid = kids2[qi];
      if (kid.nodeType === 'folder') {
        if (!isExcluded(kid)) queue.push(idOf(kid));
      } else if (kid.nodeType === 'file' || kid.nodeType === 'site') {
        if (evalAccess(folderChain(nodes, kid.parentId), viewer) !== 'none') leaves.push(kid);
      }
    }
  }

  function mimeOf(n) { return n.content_type || n.mime_type || null; }
  function sizeOf(n) {
    var sv = (typeof n.size === 'number') ? n.size : (n.size != null ? Number(n.size) : null);
    return (sv != null && !isNaN(sv)) ? sv : null;
  }
  function createdOf(n) {
    var cv = (typeof n.createdMs === 'number') ? n.createdMs : (n.createdMs != null ? Number(n.createdMs) : 0);
    return (cv != null && !isNaN(cv)) ? cv : 0;
  }

  var items = [];
  for (var li = 0; li < leaves.length; li++) {
    var lf = leaves[li];
    var lfPath = contentPath(lf);
    if (!lfPath) continue;
    items.push({
      id: idOf(lf),
      type: lf.nodeType,
      name: String(lf.displayName || lf.original_name || lf.filename || 'Untitled'),
      title: (lf.title != null && String(lf.title) !== '') ? String(lf.title) : null,
      description: (lf.description != null && String(lf.description) !== '') ? String(lf.description) : null,
      path: lfPath,
      createdAt: createdOf(lf),
      mime: mimeOf(lf),
      size: sizeOf(lf)
    });
  }
  items.sort(function (a, b) { return b.createdAt - a.createdAt; });
  if (items.length > 50) items = items.slice(0, 50);

  // Render RSS 2.0 (port of src/lib/feed.ts renderFeedXml).
  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
  // HTML-attribute-safe escape for text placed INSIDE a CDATA <img alt="...">.
  function htmlAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function descHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/\r\n?|\n/g, '<br>');
  }
  function humanSize(bytes) {
    if (bytes == null || bytes < 0) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var n = bytes, idx = 0;
    while (n >= 1024 && idx < u.length - 1) { n = n / 1024; idx++; }
    return (idx === 0 ? String(n) : n.toFixed(1)) + ' ' + u[idx];
  }
  function fileSummary(name, size) {
    var h = humanSize(size);
    return h ? (name + ' (' + h + ')') : name;
  }
  function rfc822(ms) { return new Date(ms).toUTCString(); }
  function encPath(p) {
    return String(p).split('/').map(function (x) { return encodeURIComponent(x); }).join('/');
  }
  function slugify(name) {
    var dot = name.lastIndexOf('.');
    var hasExt = dot > 0;
    var base = hasExt ? name.slice(0, dot) : name;
    var ext = hasExt ? name.slice(dot + 1) : '';
    var baseSlug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'file';
    var extSlug = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
    return extSlug ? (baseSlug + '.' + extSlug) : baseSlug;
  }

  var host = (request && request.headers && request.headers.host) || '';
  if (Object.prototype.toString.call(host) === '[object Array]') host = host[0] || '';
  var origin = host ? ('https://' + host) : '';
  var path = (steps && steps.parse && steps.parse.path) || '';
  var treeLink = origin + (path ? ('/tree/' + encPath(path)) : '/');
  var selfHref = origin + (path ? ('/feed/' + encPath(path) + '.xml') : '/feed.xml') + tokenQs;
  var title = isRoot ? 'My Files' : targetName;

  var out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">');
  out.push('<channel>');
  out.push('<title>' + xmlEscape(title) + '</title>');
  out.push('<link>' + xmlEscape(treeLink) + '</link>');
  out.push('<description>' + xmlEscape('Files and sites shared from ' + title) + '</description>');
  out.push('<atom:link href="' + xmlEscape(selfHref) + '" rel="self" type="application/rss+xml"/>');
  for (var oi = 0; oi < items.length; oi++) {
    var it = items[oi];
    out.push('<item>');
    out.push('<title>' + xmlEscape(it.title || it.name) + '</title>');
    out.push('<link>' + xmlEscape(origin + '/blob/' + encPath(it.path) + tokenQs) + '</link>');
    out.push('<guid isPermaLink="false">' + xmlEscape(it.id) + '</guid>');
    out.push('<pubDate>' + rfc822(it.createdAt) + '</pubDate>');
    if (it.type === 'file') {
      var mime = it.mime || 'application/octet-stream';
      var length = (it.size != null && it.size >= 0) ? it.size : 0;
      // A media URL a cross-domain reader can load with NONE of this app's
      // cookies. Public feed: serve the bytes directly (tokenless — the ACL
      // 'Anyone' passes — and cacheable). Private feed: use the token-in-URL
      // redirect route (/r/), since /api/uploads/content is cookie/session-gated
      // and takes no ?token=. Never emit the presigned bucket URL itself (it
      // expires in ~5 min) — emit this stable indirection so it re-resolves per
      // fetch.
      var mediaUrl = tokenOk
        ? (origin + '/r/' + it.id + '/' + slugify(it.name) + tokenQs)
        : (origin + '/api/uploads/content/' + encPath(it.path));
      out.push('<enclosure url="' + xmlEscape(mediaUrl) + '" type="' + xmlEscape(mime) + '" length="' + length + '"/>');
      var note = it.description ? ('<p>' + descHtml(it.description) + '</p>') : '';
      var isImage = !!it.mime && it.mime.indexOf('image/') === 0;
      if (isImage) {
        // Reader/article views render <description>, NOT <enclosure>; an inline
        // <img> gives them a body + the picture. CDATA keeps the HTML literal.
        out.push('<description><![CDATA[' + note + '<p><img src="' + mediaUrl + '" alt="' + htmlAttr(it.name) + '" /></p>]]></description>');
        out.push('<media:content url="' + xmlEscape(mediaUrl) + '" type="' + xmlEscape(mime) + '" medium="image"/>');
        out.push('<media:thumbnail url="' + xmlEscape(mediaUrl) + '"/>');
      } else if (note) {
        out.push('<description><![CDATA[' + note + ']]></description>');
      } else {
        out.push('<description>' + xmlEscape(fileSummary(it.name, it.size)) + '</description>');
      }
    } else {
      // Site: emit a text/html enclosure so our reader (Rivulet) embeds the site inline. The mime is a detection hint only; the reader consent-gates on the link ORIGIN, not this label, so a feed cannot skip consent by mislabelling. The <description> stays so non-embedding readers still show a body.
      out.push('<enclosure url="' + xmlEscape(origin + '/blob/' + encPath(it.path) + tokenQs) + '" type="text/html" length="0"/>');
      if (it.description) {
        out.push('<description><![CDATA[<p>' + descHtml(it.description) + '</p>]]></description>');
      } else {
        out.push('<description>' + xmlEscape(it.name) + '</description>');
      }
    }
    out.push('</item>');
  }
  out.push('</channel>');
  out.push('</rss>');

  return { found: true, notfound: false, xml: out.join('\n') };
}
