import { randomBytes } from 'node:crypto'

/** 12-char hex id for record identity. */
export function newId(): string {
  return randomBytes(6).toString('hex')
}

/** ISO datetime string (UTC). */
export function isoDateTime(d?: Date): string {
  return (d ?? new Date()).toISOString()
}

/** Validate a generated record ID before using it in a filesystem path. */
export function isSafeKey(key: string): boolean {
  return /^[a-f0-9]{12}$/.test(key)
}
