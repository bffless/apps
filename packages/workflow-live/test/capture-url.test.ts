import { zipSync, strToU8 } from 'fflate'
import { describe, test, expect } from 'vitest'
import { Report } from '../src/report.js'
import { checkCaptureZip } from '../src/walks/capture-url.js'

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))

/** `WalkReport.checks` is a Record<name, { pass, evidence }> (report.ts:12). */
const names = (r: Report) => Object.fromEntries(Object.entries(r.finish().checks).map(([name, c]) => [name, c.pass]))

describe('checkCaptureZip', () => {
  test('passes on a bundle whose manifest names the recording and carries the transcript', () => {
    const report = new Report('capture-url', 'https://h')
    checkCaptureZip(zip({
      'manifest.json': JSON.stringify({ version: 1, source: { name: 'anatomy.mp4' }, sheets: [] }),
      'transcript.md': '# anatomy.mp4\n',
      'transcript.json': '[]',
      'README.md': '',
    }), 'anatomy.mp4', report)
    expect(names(report)).toEqual({
      'captureUrl.zipHasManifest': true,
      'captureUrl.manifestNamesTheRecording': true,
      'captureUrl.zipHasTranscript': true,
    })
  })

  test('fails the name check when the manifest names something else, and the manifest check when it is missing', () => {
    const wrong = new Report('capture-url', 'https://h')
    checkCaptureZip(zip({ 'manifest.json': JSON.stringify({ source: { name: 'download.mp4' } }), 'transcript.md': '' }), 'anatomy.mp4', wrong)
    expect(names(wrong)['captureUrl.manifestNamesTheRecording']).toBe(false)

    const missing = new Report('capture-url', 'https://h')
    checkCaptureZip(zip({ 'transcript.md': '' }), 'anatomy.mp4', missing)
    expect(names(missing)['captureUrl.zipHasManifest']).toBe(false)
    expect(names(missing)['captureUrl.manifestNamesTheRecording']).toBe(false)
  })
})
