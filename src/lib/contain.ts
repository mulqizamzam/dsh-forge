import { resolve, relative, isAbsolute, sep } from 'node:path'

/**
 * Validate and resolve an untrusted package-relative path.
 * Reject Windows separators/absolute paths even on POSIX so generated packages
 * remain portable and cannot smuggle an alternate path syntax across hosts.
 * This is lexical containment; callers must also avoid trusting pre-existing
 * symlinks under writable destinations.
 */
export function containPath(root: string, candidatePath: unknown): string | null {
  if (typeof candidatePath !== 'string' || candidatePath === '') return null
  if (candidatePath.includes('\0') || candidatePath.includes('\\')) return null
  if (candidatePath.startsWith('/') || /^[a-zA-Z]:/.test(candidatePath)) return null

  const segments = candidatePath.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null

  const base = resolve(root)
  const target = resolve(base, candidatePath)
  if (target === base || isAbsolute(relative(base, target))) return null

  const rel = relative(base, target)
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep)) return null
  return target
}
