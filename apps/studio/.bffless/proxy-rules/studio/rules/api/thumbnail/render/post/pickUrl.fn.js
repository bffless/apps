function handler({ steps }) {
  var g = (steps && steps.generate) || {};
  var out = g.output != null ? g.output : g;
  var url = '';
  if (typeof out === 'string') {
    url = out;
  } else if (out && typeof out.length === 'number' && out.length) {
    url = String(out[0]);
  } else if (out && typeof out.image === 'string') {
    url = out.image;
  } else if (out && typeof out.url === 'string') {
    url = out.url;
  }
  return { url: url };
}