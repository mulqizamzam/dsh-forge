import { open, writeFile, readdir, lstat, unlink, mkdir, rename } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join, dirname } from 'node:path'
import { newId } from './ids.ts'

/** Read JSON safely without following a symlink at the final path component. */
export async function readJsonSafe(path: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    // O_NOFOLLOW closes the lstat/readFile race where the platform supports it.
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    handle = await open(path, flags)
    const metadata = await handle.stat()
    if (!metadata.isFile()) return null
    return JSON.parse(await handle.readFile({ encoding: 'utf8' }))
  } catch { return null }
  finally { await handle?.close().catch(() => {}) }
}

/** Atomic write: flush a private staged file, then rename over the destination. */
async function atomicWrite(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const directory = dirname(path)
  const tmp = path + '.tmp.' + newId()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tmp, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmp, path)

    // POSIX filesystems can persist the rename by syncing the containing
    // directory. Some platforms/filesystems do not support directory fsync,
    // so this remains best-effort while file-content fsync is mandatory.
    let directoryHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      directoryHandle = await open(directory, 'r')
      await directoryHandle.sync()
    } catch {
      // The rename already committed atomically; unsupported directory fsync
      // must not turn a committed write into a reported failure.
    } finally {
      await directoryHandle?.close().catch(() => {})
    }
  } finally {
    await handle?.close().catch(() => {})
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
