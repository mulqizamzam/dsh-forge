import { readFile, writeFile, readdir, stat, unlink, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { newId } from './ids.ts'

/** Read JSON safely; null on any error. */
export async function readJsonSafe(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

/** Atomic JSON write: write tmp then rename. Unique tmp name per call. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp.' + newId()
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

/** Atomic text write. */
export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp.' + newId()
  await writeFile(tmp, content, 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

/** List files in a dir, sorted by mtime descending. */
export async function listDir(dir: string, limit = 500): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    const withMtime: Array<{ name: string; mtime: number }> = []
    for (const name of entries) {
      try {
        const s = await stat(join(dir, name))
        if (s.isFile()) withMtime.push({ name, mtime: s.mtimeMs })
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
