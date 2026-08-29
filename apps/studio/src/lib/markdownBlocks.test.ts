import { describe, expect, it } from 'vitest'
import { parseTable, splitBlocks, splitTableRow } from './markdownBlocks'

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

describe('splitTableRow', () => {
  it('drops one leading and trailing pipe and trims the cells', () => {
    expect(splitTableRow('| Field | Type | Required |')).toEqual(['Field', 'Type', 'Required'])
    expect(splitTableRow('Field | Type')).toEqual(['Field', 'Type'])
    expect(splitTableRow('|a|b|')).toEqual(['a', 'b'])
  })

  it('keeps an empty cell and unescapes \\| into a literal pipe', () => {
    expect(splitTableRow('| a | | c |')).toEqual(['a', '', 'c'])
    expect(splitTableRow('| `a \\| b` | c |')).toEqual(['`a | b`', 'c'])
    // A trailing escaped pipe is content, not the closing bar.
    expect(splitTableRow('| a | b \\|')).toEqual(['a', 'b |'])
  })
})

describe('parseTable / splitBlocks (GFM tables, issue #441)', () => {
  const md = ['| Field | Type | Required |', '| --- | :---: | ---: |', '| `id` | string | **yes** |', '| note | text | no |'].join(
    '\n',
  )

  it('turns a header row over a delimiter row into a table block with per-column alignment', () => {
    expect(splitBlocks(md)).toEqual([
      {
        kind: 'table',
        align: [null, 'center', 'right'],
        header: ['Field', 'Type', 'Required'],
        rows: [
          ['`id`', 'string', '**yes**'],
          ['note', 'text', 'no'],
        ],
      },
    ])
    expect(parseTable('| a | b |\n| :-- | --- |')?.align).toEqual(['left', null])
  })

  it('sits between prose and code like any other block', () => {
    expect(splitBlocks(`Intro.\n\n${md}\n\n\`\`\`json\n{}\n\`\`\``).map((b) => b.kind)).toEqual(['text', 'table', 'code'])
  })

  it('pads a short row and truncates a long one to the header width', () => {
    const t = parseTable('| a | b |\n|---|---|\n| only |\n| 1 | 2 | 3 |')
    expect(t?.rows).toEqual([
      ['only', ''],
      ['1', '2', ],
    ])
  })

  it('has no body rows when the table is just a header', () => {
    expect(parseTable('| a | b |\n|---|---|')).toEqual({ kind: 'table', align: [null, null], header: ['a', 'b'], rows: [] })
  })

  it('is not a table without a delimiter row, with a column-count mismatch, or with bare pipes in prose', () => {
    expect(splitBlocks('| a | b |\n| c | d |')).toEqual([{ kind: 'text', text: '| a | b |\n| c | d |' }])
    expect(splitBlocks('| a |\n| --- | --- |')).toEqual([{ kind: 'text', text: '| a |\n| --- | --- |' }])
    expect(splitBlocks('either | or\nnot a table')).toEqual([{ kind: 'text', text: 'either | or\nnot a table' }])
    expect(splitBlocks('| lonely header |')).toEqual([{ kind: 'text', text: '| lonely header |' }])
  })
})
