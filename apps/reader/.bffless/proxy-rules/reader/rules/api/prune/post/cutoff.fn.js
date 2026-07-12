function handler() {
  var THIRTY_DAYS_MS = 2592000000
  return { ms: Date.now() - THIRTY_DAYS_MS }
}
