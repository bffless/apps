import { describe, test, expect } from 'vitest'
import { contentTypeFor, extensionFor } from '../src/mime.js'

describe('contentTypeFor', () => {
  test('maps the extensions a driver actually sends, and falls back to octet-stream', () => {
    expect(contentTypeFor('a/b/clip.mp4')).toBe('video/mp4')
    expect(contentTypeFor('clip.MOV')).toBe('video/quicktime')
    expect(contentTypeFor('mystery.qqq')).toBe('application/octet-stream')
  })
})

describe('extensionFor', () => {
  test('is the inverse of the map, ignoring case and parameters', () => {
    expect(extensionFor('video/mp4')).toBe('.mp4')
    expect(extensionFor('Video/MP4; codecs=avc1')).toBe('.mp4')
    expect(extensionFor('application/zip')).toBe('.zip')
  })
  test('is empty for a type the map does not know', () => {
    expect(extensionFor('application/x-unknown')).toBe('')
    expect(extensionFor('')).toBe('')
  })
  test('prefers the canonical extension when two share a type', () => {
    // .jpg and .jpeg both map to image/jpeg; .htm/.html to text/html; .yml/.yaml to application/yaml
    expect(extensionFor('image/jpeg')).toBe('.jpg')
    expect(extensionFor('text/html')).toBe('.html')
    expect(extensionFor('application/yaml')).toBe('.yaml')
  })
})
