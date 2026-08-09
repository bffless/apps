import { test, expect } from 'vitest';
import { extractYouTubeId, youTubeDeepLink } from './youtube';

test.each([
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ['https://youtu.be/dQw4w9WgXcQ?t=10', 'dQw4w9WgXcQ'],
  ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ['https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ['not a url', null],
  ['https://vimeo.com/12345', null],
])('extractYouTubeId(%s) -> %s', (input, expected) => {
  expect(extractYouTubeId(input)).toBe(expected);
});

test('youTubeDeepLink rounds to whole seconds', () => {
  expect(youTubeDeepLink('dQw4w9WgXcQ', 754.4))
    .toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754s');
});
