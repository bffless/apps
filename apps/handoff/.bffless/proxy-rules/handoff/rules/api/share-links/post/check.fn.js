function handler({ user, steps }) {
  var folder = (steps && steps.folder) || {};
  var uid = (user && user.id) || null;
  var isAdmin = !!user && user.role === 'admin';
  var isOwner = !!uid && folder.ownerId === uid;
  var allowed = isAdmin || isOwner;
  return { allowed: allowed, denied: !allowed };
}