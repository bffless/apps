import { describe, it, expect } from 'vitest'
import {
  encodePath,
  pathFromPathname,
  treeUrl,
  blobUrl,
  feedUrl,
  parentPath,
  nodeUrl,
  crumbPathAt,
} from './pathUrl'

describe('encodePath / pathFromPathname round-trip', () => {
  it('encodes each segment, preserving slashes between them', () => {
    expect(encodePath('Test/My File.png')).toBe('Test/My%20File.png')
    expect(encodePath('Rapport Été/résumé.md')).toBe(
      'Rapport%20%C3%89t%C3%A9/r%C3%A9sum%C3%A9.md',
    )
  })

  it('round-trips spaces, U+202F, unicode and literal %', () => {
    const names = [
      'Test/Screenshot 2026-07-05 at 2.07.28 PM.png',
      'Rapport Été/résumé.md',
      'a&b/c#d.txt',
      '100%.png',
    ]
    for (const p of names) {
      expect(pathFromPathname(`/blob/${encodePath(p)}`, '/blob/')).toBe(p)
    }
  })

  it('keeps a raw segment on a malformed escape instead of throwing', () => {
    expect(pathFromPathname('/tree/Test/100%zz', '/tree/')).toBe('Test/100%zz')
  })

  it('drops empty segments and returns "" for the bare prefix', () => {
    expect(pathFromPathname('/tree/', '/tree/')).toBe('')
    expect(pathFromPathname('/tree//Test//', '/tree/')).toBe('Test')
    expect(pathFromPathname('/other/x', '/tree/')).toBe('')
  })
})

describe('URL builders', () => {
  it('treeUrl maps "" to "/" and encodes otherwise', () => {
    expect(treeUrl('')).toBe('/')
    expect(treeUrl('Test/Sub Folder')).toBe('/tree/Test/Sub%20Folder')
  })

  it('blobUrl always encodes under /blob/', () => {
    expect(blobUrl('Test/My File.png')).toBe('/blob/Test/My%20File.png')
  })

  it('feedUrl maps "" to /feed.xml and encodes otherwise', () => {
    expect(feedUrl('')).toBe('/feed.xml')
    expect(feedUrl('Test')).toBe('/feed/Test.xml')
    expect(feedUrl('Test/Sub Folder')).toBe('/feed/Test/Sub%20Folder.xml')
  })

  it('parentPath strips the final segment', () => {
    expect(parentPath('Test/Sub/file.png')).toBe('Test/Sub')
    expect(parentPath('file.png')).toBe('')
    expect(parentPath('')).toBe('')
  })

  it('nodeUrl prefers path URLs and falls back to legacy id URLs', () => {
    expect(nodeUrl({ type: 'folder', path: 'Test', id: 'f1' })).toBe('/tree/Test')
    expect(nodeUrl({ type: 'folder', path: null, id: 'f1' })).toBe('/folder/f1')
    expect(nodeUrl({ type: 'file', path: 'Test/a.png', id: 'n1' })).toBe('/blob/Test/a.png')
    expect(nodeUrl({ type: 'site', path: null, id: 's1' })).toBe('/view/s1')
    expect(nodeUrl({ type: 'file', path: '', id: 'n2' })).toBe('/view/n2')
  })

  it('nodeUrl routes a root-type node to the app root, regardless of path', () => {
    expect(nodeUrl({ type: 'root', path: null, id: 'R' })).toBe('/')
    // Even if a root node somehow carried a path, root still wins — there is
    // no /tree/ URL for the singleton root record.
    expect(nodeUrl({ type: 'root', path: 'whatever', id: 'R' })).toBe('/')
  })

  it('crumbPathAt joins names after the synthetic root crumb', () => {
    const crumbs = [{ name: '~/' }, { name: 'Test' }, { name: 'Sub Folder' }]
    expect(crumbPathAt(crumbs, 0)).toBe('')
    expect(crumbPathAt(crumbs, 1)).toBe('Test')
    expect(crumbPathAt(crumbs, 2)).toBe('Test/Sub Folder')
  })
})
