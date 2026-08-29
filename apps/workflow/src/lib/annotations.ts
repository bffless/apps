import type { Annotation } from './runner/types'

/**
 * The three annotation levels, loudest first (01).
 *
 * One list, because two screens read it in the same order and for the same
 * reason: the run header counts them loudest-first so the worst thing about a
 * run is the first thing on it, and the runs list draws all three badges in
 * that order so a column of rows is scannable down its own width. They were
 * declared separately in each file, which is a silent way for the two to
 * disagree (apps#382).
 */
export const ANNOTATION_LEVELS: readonly Annotation['level'][] = ['error', 'warning', 'notice']
