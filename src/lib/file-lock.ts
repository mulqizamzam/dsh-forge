import { open, lstat, readFile, rename, unlink, link } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

type LockOwner = {
  token: string
  pid: number
  host: string
  createdAt: number
  processStart?: string
}

export interface FileLockOptions {
  timeoutMs?: number
  /** Age before an owner-less/corrupt file is considered abandoned. */
  staleInitializingMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_STALE_INITIALIZING_MS = 15_000

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

async function linuxProcessStart(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined
  try {
    const raw = await readFile('/proc/' + String(pid) + '/stat', 'utf8')
    const close = raw.lastIndexOf(')')
    if (close < 0) return undefined
    // The suffix starts at field 3 (state), so field 22 (starttime) is index 19.
    return raw.slice(close + 1).trim().split(/\s+/)[19]
  } catch {
    return undefined
  }
}

async function readLockOwner(path: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (typeof parsed.token !== 'string' || parsed.token.length < 16 ||
        typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
        typeof parsed.host !== 'string' || typeof parsed.createdAt !== 'number' ||
        !Number.isFinite(parsed.createdAt)) return null
    return {
      token: parsed.token,
      pid: parsed.pid,
      host: parsed.host,
      createdAt: parsed.createdAt,
      ...(typeof parsed.processStart === 'string' ? { processStart: parsed.processStart } : {}),
    }
  } catch {
    return null
  }
}

async function lockIsStale(path: string, staleInitializingMs: number): Promise<boolean> {
  let info
  try { info = await lstat(path) } catch (error) {
    if (errorCode(error) === 'ENOENT') return true
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('lock path is not a regular file: ' + path)
  }

  const owner = await readLockOwner(path)
  if (!owner) {
    return Date.now() - info.mtimeMs > staleInitializingMs
  }
  // A different host cannot safely determine whether the owner is alive. Fail
  // closed and require manual recovery instead of stealing a potentially live lock.
  if (owner.host !== hostname()) return false

  let alive = true
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ESRCH') alive = false
    else if (code === 'EPERM') alive = true
    else return false
  }
  if (!alive) return true

  if (owner.processStart) {
    const currentStart = await linuxProcessStart(owner.pid)
    if (currentStart && currentStart !== owner.processStart) return true
  }
  return false
}

/**
 * Run an async operation under an exclusive filesystem lock shared by processes.
 * Lock owners are PID/host identified; only provably dead same-host owners are
 * reclaimed automatically. Locks from another host time out rather than being
 * stolen because remote process liveness cannot be established safely.
 */
export async function withFileLock<T>(
  path: string,
  action: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const lockPath = resolve(path)
  const parent = dirname(lockPath)
  const parentInfo = await lstat(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error('lock parent must be a real directory: ' + parent)
  }

  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(100, Math.min(10 * 60_000, Math.floor(options.timeoutMs!)))
    : DEFAULT_TIMEOUT_MS
  const staleInitializingMs = Number.isFinite(options.staleInitializingMs)
    ? Math.max(1_000, Math.min(5 * 60_000, Math.floor(options.staleInitializingMs!)))
    : DEFAULT_STALE_INITIALIZING_MS
  const deadline = Date.now() + timeoutMs
  const token = randomUUID()
  const processStart = await linuxProcessStart(process.pid)
  const owner: LockOwner = {
    token,
    pid: process.pid,
    host: hostname(),
    createdAt: Date.now(),
    ...(processStart ? { processStart } : {}),
  }

  let acquired = false
  while (!acquired) {
    // Write a complete owner record before publishing the lock name. Contenders
    // never observe an empty/partially-written lock that could be mistaken for
    // an abandoned owner during a long scheduler pause.
    const initializingPath = lockPath + '.init-' + randomUUID()
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(initializingPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(owner), 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      try {
        // Hard-link creation fails atomically if another owner already published
        // the canonical lock path. Both files are in the same directory/filesystem.
        await link(initializingPath, lockPath)
        acquired = true
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
    } finally {
      await handle?.close().catch(() => {})
      await unlink(initializingPath).catch(() => {})
    }

    if (acquired) break
    if (await lockIsStale(lockPath, staleInitializingMs)) {
      const retired = lockPath + '.stale-' + randomUUID()
      try {
        await rename(lockPath, retired)
        await unlink(retired).catch(() => {})
        continue
      } catch (renameError) {
        const code = errorCode(renameError)
        if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') continue
        throw renameError
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for cross-process lock: ' + lockPath)
    }
    await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 50))
  }

  try {
    return await action()
  } finally {
    const current = await readLockOwner(lockPath)
    if (current?.token === token) await unlink(lockPath).catch(() => {})
  }
}  try {
    return await action()
  } finally {
    const current = await readLockOwner(lockPath)
    if (current?.token === token) await unlink(lockPath).catch(() => {})
  }
}
