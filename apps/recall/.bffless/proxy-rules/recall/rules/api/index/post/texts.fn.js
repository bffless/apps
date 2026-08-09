// Replicate's nateraw/bge-large-en-v1.5 takes its `texts` input as a
// JSON-STRINGIFIED array of strings (verified against the model's public
// OpenAPI schema, not a live prediction -- see rule.yaml's description and
// task-8-report.md). Expression configs can't build that string inline, so
// this step does it: JSON.stringify over the chunk texts, in the same order
// zip.fn.js will need to pair them back up with steps.embed.output.
function handler({ steps }) {
  var chunk = (steps && steps.chunk) || {}
  var chunks = chunk.chunks || []
  var texts = chunks.map(function (c) {
    return c.text
  })
  return { textsJson: JSON.stringify(texts) }
}
