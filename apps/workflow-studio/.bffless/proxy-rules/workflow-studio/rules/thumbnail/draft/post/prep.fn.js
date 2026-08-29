function handler({ request }) {
  var b = (request && request.body) || {};
  function s(v){ return typeof v === 'string' ? v : ''; }
  var msg = '';
  msg += 'TITLE:\n' + s(b.title) + '\n\n';
  msg += 'DESCRIPTION:\n' + s(b.description) + '\n\n';
  msg += 'SCRIPT (final spoken narration, in order):\n' + s(b.script) + '\n\n';
  msg += 'NOTES (creator wishes, optional):\n' + s(b.notes) + '\n\n';
  // Whether the render step will hand nano-banana a reference photo as
  // `image_input`. Written blind, the prompt describes a self-contained
  // illustration and bans photorealistic humans - so the attached photo gets
  // ignored. The system prompt's REFERENCE IMAGE section reads this line.
  msg += 'REFERENCE IMAGE:\n' + (b.hasReference === true
    ? 'ATTACHED - the creator uploaded a photo (usually of themselves, sometimes a product) and it is passed to the image model together with your prompt. Write the prompt so the model BUILDS THE THUMBNAIL AROUND IT.'
    : 'none.');
  return { message: msg };
}
