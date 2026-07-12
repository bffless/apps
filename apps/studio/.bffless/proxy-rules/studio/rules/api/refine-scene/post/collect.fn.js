function handler({ steps }) {
  var images = []
  for (var i = 0; i < 10; i++) {
    var st = steps['sign' + i]
    if (st && st.url) images.push(st.url)
  }
  return { images: images, count: images.length }
}
