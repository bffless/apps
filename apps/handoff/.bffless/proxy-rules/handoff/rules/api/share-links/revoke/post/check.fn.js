function handler({ user, steps }) {
  var l = (steps && steps.link) || {};
  var uid = (user && user.id) || null;
  var isAdmin = !!user && user.role === 'admin';
  var isCreator = !!uid && l.createdBy === uid;
  var allowed = !!l.folderId && (isAdmin || isCreator);
  return { allowed: allowed, denied: !allowed };
}