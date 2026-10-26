import { randomBytes } from 'node:crypto'

/** 12-char hex id for record identity. */
export function newId(): string {
  return randomBytes(6).toString('hex')
}

/** ISO datetime string (UTC). */
export function isoDateTime(d?: Date): string {
  return (d ?? new Date()).toISOString()
}

/** Validate a key is safe for filesystem use. */
export function isSafeKey(key: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key)
}
