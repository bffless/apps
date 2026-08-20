/** `2 jobs` / `1 job` — counted labels, spelled the same way on every screen. */
export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
