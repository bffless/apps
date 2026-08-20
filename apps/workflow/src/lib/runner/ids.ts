// Compact Crockford-base32 ULID: 10 time chars + 16 random chars = 26 chars total.
// Crockford's alphabet excludes I, L, O, U to avoid visual ambiguity.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16

function encodeTime(time: number, len: number): string {
  let str = ''
  let t = time
  for (let i = len - 1; i >= 0; i--) {
    const mod = t % 32
    str = CROCKFORD[mod] + str
    t = (t - mod) / 32
  }
  return str
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let str = ''
  for (let i = 0; i < len; i++) {
    str += CROCKFORD[bytes[i]! % 32]
  }
  return str
}

function ulid(): string {
  return encodeTime(Date.now(), TIME_LEN) + encodeRandom(RANDOM_LEN)
}

export function newRunId(): string {
  return `run_${ulid()}`
}

export function newOwnerId(): string {
  return `tab_${ulid()}`
}
