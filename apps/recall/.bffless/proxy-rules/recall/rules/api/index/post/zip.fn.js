// Pairs steps.chunk.chunks[i] with its same-index embedding vector from
// steps.embed.output[i] (the replicate handler's runtime output shape wraps
// the model's raw output at `steps.embed.output` -- see
// apps/backend/src/pipelines/handlers/replicate.handler.ts's StepResult).
// Defensive against steps.embed being missing entirely (e.g. the replicate
// step failed outright -- postSteps don't abort on a failed step, so zip
// still runs whenever chunkCheck passed): that's treated the same as a
// length mismatch, not a crash.
//
// Also validates each vector's SHAPE, not just the array lengths: the
// model's own published OpenAPI schema types its output items as a bare
// `string` (see rule.yaml's description -- almost certainly a Cog
// schema-generation quirk, since the model card describes float vectors),
// so until that's confirmed against a live prediction (Task 12), a response
// that doesn't actually look like `number[]` per item must be rejected here
// rather than silently stored as garbage embeddings.
function handler({ steps }) {
  var chunkStep = (steps && steps.chunk) || {}
  var chunks = chunkStep.chunks || []
  var embedStep = (steps && steps.embed) || {}
  var vectors = embedStep.output || []

  if (!Array.isArray(vectors) || vectors.length !== chunks.length) {
    return { error: 'EMBED_COUNT_MISMATCH', chunks: [] }
  }

  for (var i = 0; i < vectors.length; i++) {
    var v = vectors[i]
    if (!Array.isArray(v) || typeof v[0] !== 'number') {
      return { error: 'EMBED_SHAPE_ERROR', chunks: [] }
    }
  }

  var zipped = chunks.map(function (c, i) {
    return { embedding: vectors[i], text: c.text, metadata: c.metadata }
  })

  return { chunks: zipped }
}
