function handler({ request }) {
  var p = (request && request.path) || '';
  var q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);

  // request.path is the internal rewritten path (a deployment prefix + the app
  // route). The deployment prefix contains no '/feed/' segment, so the FIRST
  // '/feed/' marks the folder feed route; without it the request is the root
  // feed ('/feed.xml', which has no '/feed/' segment).
  var rest;
  var marker = '/feed/';
  var i = p.indexOf(marker);
  if (i >= 0) {
    rest = p.slice(i + marker.length);
    if (rest.slice(-4) === '.xml') rest = rest.slice(0, -4);
  } else {
    rest = '';
  }

  var rawSegs = rest.split('/');
  var segs = [];
  var bad = false;
  for (var s = 0; s < rawSegs.length; s++) {
    var sg = rawSegs[s];
    if (!sg) continue;
    try { sg = decodeURIComponent(sg); } catch (e) { /* malformed escape - keep raw */ }
    if (sg === '.' || sg === '..') { bad = true; break; }
    segs.push(sg);
  }

  // A private feed carries a Share Link ?token= (ADR-0008); surface it (and
  // whether it is a well-formed UUID) so the link lookup + gate can run.
  var query = (request && request.query) || {};
  var token = String(query.token || '');
  var UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  var hasToken = UUID.test(token);

  return {
    path: segs.join('/'),
    segments: segs,
    isRoot: segs.length === 0,
    bad: bad,
    token: token,
    hasToken: hasToken
  };
}
