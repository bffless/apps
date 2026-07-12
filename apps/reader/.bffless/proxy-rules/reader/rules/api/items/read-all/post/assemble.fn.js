function handler({ steps }) {
  function c(u) { return (u && typeof u.count === 'number') ? u.count : null }
  var n = c(steps.updAll)
  if (n == null) n = c(steps.updStarred)
  if (n == null) n = c(steps.updFeed)
  if (n == null) n = c(steps.updFolder)
  if (n == null) n = 0
  return { updated: n }
}
