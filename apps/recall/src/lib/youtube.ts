/**
 * YouTube URL/id helpers. `extractYouTubeId` accepts any of the common URL
 * shapes (watch, youtu.be, shorts, embed, live) or a bare 11-char video id;
 * `youTubeDeepLink` builds a `&t=<seconds>s` deep link back into the video at
 * a given transcript moment; `extractYouTubeTimestamp` reverses that for a
 * link's `t=` query param (used by `CitationChip` to parse chat citation
 * links like `...&t=754s` back into a start second).
 */

export function extractYouTubeId(input: string): string | null {
  const m = input.match(
    /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
  );
  if (m) return m[1];
  const trimmed = input.trim();
  return /^[A-Za-z0-9_-]{11}$/.test(trimmed) ? trimmed : null;
}

export function youTubeDeepLink(id: string, startSec: number): string {
  return `https://www.youtube.com/watch?v=${id}&t=${Math.round(startSec)}s`;
}

export function extractYouTubeTimestamp(input: string): number | null {
  let search: string;
  try {
    search = new URL(input).search;
  } catch {
    const i = input.indexOf('?');
    search = i === -1 ? '' : input.slice(i);
  }
  const t = new URLSearchParams(search).get('t');
  if (!t) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}
