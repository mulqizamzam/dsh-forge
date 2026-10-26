import { resolve, relative, isAbsolute, sep } from 'node:path'

/**
 * Path containment for untrusted relative paths. `resolve(root, candidate)`
 * must land strictly INSIDE `root`, proven with `relative()` so prefix
 * collisions like `/root/files2/x` cannot pass. Purely lexical — callers
 * that need symlink defence must realpath() after this check.
 */
export function containPath(root: string, candidatePath: unknown): string | null {
  if (typeof candidatePath !== 'string') return null
  if (candidatePath === '' || candidatePath.includes('\0')) return null

  const base = resolve(root)
  const target = resolve(base, candidatePath)
  if (target === base) return null

  const rel = relative(base, target)
  if (rel === '') return null
  if (isAbsolute(rel)) return null
  if (rel === '..' || rel.startsWith('..' + sep)) return null
  return target
}
