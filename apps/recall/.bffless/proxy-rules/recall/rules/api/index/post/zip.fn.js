// Pairs steps.chunk.chunks[i] with its same-index embedding vector from
// steps.embed.output[i] (the replicate handler's runtime output shape wraps
// the model's raw output at `steps.embed.output` -- see
// apps/backend/src/pipelines/handlers/replicate.handler.ts's StepResult).
// Defensive against steps.embed being missing entirely (e.g. the replicate
// step failed outright -- postSteps don't abort on a failed step, so zip
// still runs whenever chunkCheck passed): that's treated the same as a
// length mismatch, not a crash.
function handler({ steps }) {
  var chunkStep = (steps && steps.chunk) || {}
  var chunks = chunkStep.chunks || []
  var embedStep = (steps && steps.embed) || {}
  var vectors = embedStep.output || []

  if (!Array.isArray(vectors) || vectors.length !== chunks.length) {
    return { error: 'EMBED_COUNT_MISMATCH', chunks: [] }
  }

  var zipped = chunks.map(function (c, i) {
    return { embedding: vectors[i], text: c.text, metadata: c.metadata }
  })

  return { chunks: zipped }
}
