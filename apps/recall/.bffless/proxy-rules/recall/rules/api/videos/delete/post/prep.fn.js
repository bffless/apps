// sourceSubDir/audioSubDir/sheetsSubDir mirror the LITERAL `sub_dir` values
// register_upload writes onto each recall_uploads bookkeeping row (no
// trailing slash, no dateBucket segment -- register_upload records the
// resolved subDir expression as-is, e.g. "videos/<id>/source"; see the
// prepare/register rule pairs under uploads/{source,audio,sheet}/). Used
// below to delete-by-query those rows so they don't outlive the bucket
// objects/record they describe.
function handler({ request }) {
  var id = String((request.body && request.body.videoId) || '').trim()
  if (!id) throw new Error('videoId required')
  return {
    videoId: id,
    prefix: 'videos/' + id + '/',
    sheetsPrefix: 'sheets/' + id + '/',
    sourceSubDir: 'videos/' + id + '/source',
    audioSubDir: 'videos/' + id + '/audio',
    sheetsSubDir: 'sheets/' + id,
  }
}
