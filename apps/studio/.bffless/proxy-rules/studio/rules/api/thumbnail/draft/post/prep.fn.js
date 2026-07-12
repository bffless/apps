function handler({ request }) {
  var b = (request && request.body) || {};
  function s(v){ return typeof v === 'string' ? v : ''; }
  var msg = '';
  msg += 'TITLE:\n' + s(b.title) + '\n\n';
  msg += 'DESCRIPTION:\n' + s(b.description) + '\n\n';
  msg += 'SCRIPT (final spoken narration, in order):\n' + s(b.script) + '\n\n';
  msg += 'NOTES (creator wishes, optional):\n' + s(b.notes);
  return { message: msg };
}