function handler({ steps }) {
  var pre = (steps && steps.pre) || {};
  if (!pre.check) return { collision: false, ok: true };

  // A name is a path segment under verbatim keys, so it collides with ANY
  // same-named sibling regardless of owner — root included (issue #225).
  var rows = (steps && steps.sibling) || [];
  var hit = false;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    var nm = (r.displayName != null) ? r.displayName : ((r.original_name != null) ? r.original_name : r.filename);
    if (nm === pre.name) { hit = true; break; }
  }
  return { collision: hit, ok: !hit };
}