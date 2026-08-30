/**
 * Where a job, a step or a job's `strategy` sits in a workflow's YAML, as
 * 1-based source line ranges — what the run page's YAML drawer marks (08,
 * apps#449).
 *
 * Read off the run's **stored snapshot** (D16), never the file the
 * implementation publishes now: the drawer shows what ran, and a past run's
 * step is found in the text that run kept, so a republished file cannot move
 * the marker onto the wrong block.
 *
 * Positions come from the `yaml` document model (`parseDocument` +
 * `LineCounter`), the same pair the linter's `locate` uses — not from a
 * regex over the text — so a step is the `jobs.<job>.steps[<index>]` item by
 * position, whatever its `id` looks like and however it is indented. A block
 * that cannot be found (a snapshot too broken to parse, a job or step the
 * definition never had) yields no range at all rather than a guess: the
 * drawer then shows the file unmarked and says so.
 */
import { LineCounter, isMap, isNode, isPair, isScalar, isSeq, parseDocument } from 'yaml'
import type { Node, Pair, YAMLMap } from 'yaml'

/** Inclusive, 1-based source lines. */
export interface LineRange {
  from: number
  to: number
}

export interface YamlBlockTarget {
  /** The job's id under `jobs:`. */
  job: string
  /** The step's position in `jobs.<job>.steps` — absent for a job-level selection. */
  step?: number
  /** Also mark the job's `strategy:` block (a matrix leg shows the fan-out it came from). */
  strategy?: boolean
}

function pairOf(map: YAMLMap, key: string): Pair<Node, Node> | undefined {
  return map.items.find((item): item is Pair<Node, Node> => isPair(item) && isScalar(item.key) && item.key.value === key)
}

/** The lines a pair spans: from its key to the end of its value (an empty value is just the key). */
function pairRange(counter: LineCounter, pair: Pair<Node, Node>): LineRange | undefined {
  const start = pair.key.range?.[0]
  if (start === undefined) return undefined
  const end = isNode(pair.value) && pair.value.range ? pair.value.range[1] : (pair.key.range?.[1] ?? start)
  return nodeLines(counter, start, end)
}

function nodeLines(counter: LineCounter, start: number, end: number): LineRange {
  return {
    from: counter.linePos(start).line,
    // `end` is the offset *after* the last character; the line of the last
    // character itself is the one a reader would count.
    to: counter.linePos(Math.max(start, end - 1)).line,
  }
}

/**
 * The block(s) to mark for `target`, in source order; empty when none can be
 * located. A step target that names a step the job does not have falls back
 * to the job block, so the drawer still lands somewhere true.
 */
export function locateYamlBlocks(source: string, target: YamlBlockTarget): LineRange[] {
  const counter = new LineCounter()
  let jobs: unknown
  try {
    jobs = parseDocument(source, { lineCounter: counter }).get('jobs', true)
  } catch {
    return []
  }
  if (!isMap(jobs)) return []
  const jobPair = pairOf(jobs, target.job)
  if (!jobPair) return []
  const job = jobPair.value

  const ranges: LineRange[] = []
  if (target.step === undefined || !isMap(job)) {
    const range = pairRange(counter, jobPair)
    return range ? [range] : []
  }

  if (target.strategy) {
    const strategy = pairOf(job, 'strategy')
    const range = strategy && pairRange(counter, strategy)
    if (range) ranges.push(range)
  }

  const steps = job.get('steps', true)
  const item = isSeq(steps) ? steps.items[target.step] : undefined
  if (isNode(item) && item.range) {
    ranges.push(nodeLines(counter, item.range[0], item.range[1]))
  } else {
    const range = pairRange(counter, jobPair)
    return range ? [range] : []
  }

  return ranges.sort((a, b) => a.from - b.from)
}

/** `from` is inside one of `ranges`. */
export function isMarked(ranges: readonly LineRange[], line: number): boolean {
  return ranges.some((range) => line >= range.from && line <= range.to)
}

/** `lines 25–32` / `lines 21–23, 25–32` — the drawer's own note of what it marked. */
export function describeRanges(ranges: readonly LineRange[]): string | undefined {
  if (ranges.length === 0) return undefined
  const parts = ranges.map((range) => (range.from === range.to ? `${range.from}` : `${range.from}–${range.to}`))
  const single = ranges.length === 1 && ranges[0]!.from === ranges[0]!.to
  return `${single ? 'line' : 'lines'} ${parts.join(', ')}`
}
