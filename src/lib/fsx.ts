import { readFile, writeFile, readdir, lstat, unlink, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { newId } from './ids.ts'

/** Read JSON safely; null on any error. */
export async function readJsonSafe(path: string): Promise<unknown> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null
    return JSON.parse(await readFile(path, 'utf8'))
  } catch { return null }
}

/** Atomically replace a file and always remove the staging file on failure. */
async function atomicWrite(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp.' + newId()
  try {
    await writeFile(tmp, content, { encoding: 'utf8', mode, flag: 'wx' })
    const { rename } = await import('node:fs/promises')
    await rename(tmp, path)
  } finally {
    await unlink(tmp).catch(() => { /* rename already consumed it, or write never completed */ })
  }
}

/** Atomic JSON write: stage privately, then rename over the destination. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const serialized = JSON.stringify(data, null, 2)
  if (serialized === undefined) throw new TypeError('cannot serialize undefined as a JSON record')
  await atomicWrite(path, serialized + '\n')
}

/** Atomic text write. */
export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await atomicWrite(path, content)
}

/** List files in a dir, sorted by mtime descending. */
export async function listDir(dir: string, limit = 500): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    const withMtime: Array<{ name: string; mtime: number }> = []
    for (const name of entries) {
      try {
        const s = await lstat(join(dir, name))
        if (s.isFile() && !s.isSymbolicLink()) withMtime.push({ name, mtime: s.mtimeMs })
      } catch { /* skip */ }
    }
    withMtime.sort((a, b) => b.mtime - a.mtime)
    return withMtime.slice(0, limit).map(e => e.name)
  } catch { return [] }
}

/** Delete a file if it exists. */
export async function removeFile(path: string): Promise<boolean> {
  try { await unlink(path); return true } catch { return false }
}
