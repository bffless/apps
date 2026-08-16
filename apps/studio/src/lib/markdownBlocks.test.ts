import { describe, expect, it } from 'vitest'
import { splitBlocks } from './markdownBlocks'

describe('splitBlocks (fenced code + mermaid)', () => {
  it('splits plain prose on blank lines as before', () => {
    expect(splitBlocks('One.\n\nTwo.\n\n\nThree.')).toEqual([
      { kind: 'text', text: 'One.' },
      { kind: 'text', text: 'Two.' },
      { kind: 'text', text: 'Three.' },
    ])
  })

  it('keeps a fenced block together even when it contains blank lines', () => {
    const md = 'Intro.\n\n```mermaid\nflowchart LR\n\n  A --> B\n```\n\nOutro.'
    expect(splitBlocks(md)).toEqual([
      { kind: 'text', text: 'Intro.' },
      { kind: 'code', lang: 'mermaid', code: 'flowchart LR\n\n  A --> B' },
      { kind: 'text', text: 'Outro.' },
    ])
  })

  it('reads the language from the info string, lowercased, and allows ~~~ fences', () => {
    expect(splitBlocks('```TypeScript title=x\nconst a = 1\n```')).toEqual([
      { kind: 'code', lang: 'typescript', code: 'const a = 1' },
    ])
    expect(splitBlocks('~~~bash\nls -la\n~~~')).toEqual([{ kind: 'code', lang: 'bash', code: 'ls -la' }])
    expect(splitBlocks('```\nplain\n```')).toEqual([{ kind: 'code', lang: '', code: 'plain' }])
  })

  it('does not close a ``` fence on a longer/shorter marker or an indented-looking one inside code', () => {
    const md = '````md\n```js\nx\n```\n````\n\nAfter.'
    expect(splitBlocks(md)).toEqual([
      { kind: 'code', lang: 'md', code: '```js\nx\n```' },
      { kind: 'text', text: 'After.' },
    ])
  })

  it('an unterminated fence runs to the end of the post rather than throwing', () => {
    expect(splitBlocks('Text.\n\n```json\n{"a": 1}\n')).toEqual([
      { kind: 'text', text: 'Text.' },
      { kind: 'code', lang: 'json', code: '{"a": 1}' },
    ])
  })
})
