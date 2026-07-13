function handler({ steps }) {
  var pre = (steps && steps.resolveRootPre) || {};
  var rows = (steps && steps.rootRecord);
  var exists = false;
  if (Object.prototype.toString.call(rows) === '[object Array]') { exists = rows.length > 0; }
  else if (rows) { exists = true; }
  return { shouldCreate: (pre.isRoot === true) && (pre.isAdmin === true) && (exists === false) };
}