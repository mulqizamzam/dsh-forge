import { join, resolve, parse, relative, sep } from 'node:path'
import { mkdir, lstat, chmod, realpath } from 'node:fs/promises'
import { readJsonSafe, writeJsonAtomic, listDir } from '../lib/fsx.ts'
import { newId, isoDateTime, isSafeKey } from '../lib/ids.ts'
import type { ForgeRecord, PluginFile } from './types.ts'

export interface ForgeStoreOptions {
  root: string
  now?: () => Date
}

export class ForgeStore {
  private readonly root: string
  private readonly nowFn: () => Date
  private readonly recordLocks = new Map<string, Promise<void>>()

  constructor(opts: ForgeStoreOptions) {
    this.root = opts.root
    this.nowFn = opts.now ?? (() => new Date())
  }

  getRoot(): string { return this.root }

  /** Reject symlinks in every existing path component, not just the leaf. */
  private async assertPathHasNoSymlink(path: string): Promise<void> {
    const absolute = resolve(path)
    const filesystemRoot = parse(absolute).root
    const parts = absolute.slice(filesystemRoot.length).split(sep).filter(Boolean)
    let current = filesystemRoot
    for (const part of parts) {
      current = join(current, part)
      const info = await lstat(current)
      if (info.isSymbolicLink()) {
        throw new Error('state path must not contain symlinks: ' + current)
      }
    }
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
    await this.assertPathHasNoSymlink(path)
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('state directory must be a real directory, not a symlink: ' + path)
    }
    // State contains generated source and prompts; do not expose it to other users.
    await chmod(path, 0o700)
  }

  async init(): Promise<void> {
    const root = resolve(this.root)
    const filesystemRoot = parse(root).root
    if (root === filesystemRoot) {
      throw new Error('stateRoot must not be a filesystem root')
    }
    const home = process.env.HOME ?? process.env.USERPROFILE
    const protectedPaths = [resolve(process.cwd()), ...(home ? [resolve(home)] : [])]
    for (const protectedPath of protectedPaths) {
      const rel = relative(root, protectedPath)
      if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep))) {
        throw new Error('stateRoot must be a dedicated subdirectory, not a home directory or an ancestor of the working directory')
      }
    }

    // Do not chmod the user-selected stateRoot: it may already contain unrelated
    // files, or be intentionally shared. Only change permissions on our own
    // dedicated subdirectories.
    await mkdir(root, { recursive: true, mode: 0o700 })
    await this.assertPathHasNoSymlink(root)
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error('stateRoot must be a real directory, not a symlink')
    }
    // Canonicalize after validation so later joins do not retain a lexical alias.
    if (await realpath(root) !== root) {
      throw new Error('stateRoot must not resolve through a non-canonical path')
    }
    for (const name of ['records', 'installed', 'exports']) {
      await this.ensurePrivateDirectory(join(root, name))
    }
  }

  private recordsDir(): string { return join(this.root, 'records') }

  async add(input: {
    name: string
    description: string
    files: PluginFile[]
    llmUsage?: ForgeRecord['llmUsage']
  }): Promise<ForgeRecord> {
    const full: ForgeRecord = {
      id: newId(),
      name: input.name,
      description: input.description,
      createdAt: isoDateTime(this.nowFn()),
      updatedAt: isoDateTime(this.nowFn()),
      status: 'generated',
      files: input.files,
      llmUsage: input.llmUsage,
    }
    await writeJsonAtomic(join(this.recordsDir(), `${full.id}.json`), full)
    return full
  }

  async get(id: string): Promise<ForgeRecord | null> {
    if (!isSafeKey(id)) return null
    const value = await readJsonSafe(join(this.recordsDir(), `${id}.json`))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (record.id !== id || typeof record.name !== 'string' || typeof record.description !== 'string') return null
    if (!Array.isArray(record.files) || !record.files.every(file =>
      !!file && typeof file === 'object'
      && typeof (file as Record<string, unknown>).path === 'string'
      && typeof (file as Record<string, unknown>).content === 'string'
    )) return null
    if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) return null
    if (typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) return null
    if (!['generated', 'validated', 'tested', 'installed', 'active', 'failed'].includes(String(record.status))) return null
    if (record.validation !== undefined) {
      if (!record.validation || typeof record.validation !== 'object' || Array.isArray(record.validation)) return null
      const validation = record.validation as Record<string, unknown>
      if (typeof validation.valid !== 'boolean' || !Array.isArray(validation.errors) ||
          !validation.errors.every(v => typeof v === 'string') || !Array.isArray(validation.warnings) ||
          !validation.warnings.every(v => typeof v === 'string') ||
          typeof validation.checkedAt !== 'string' || !Number.isFinite(Date.parse(validation.checkedAt))) return null
      if (validation.contentSha256 !== undefined && (typeof validation.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(validation.contentSha256))) return null
    }
    if (record.test !== undefined) {
      if (!record.test || typeof record.test !== 'object' || Array.isArray(record.test)) return null
      const test = record.test as Record<string, unknown>
      if (typeof test.passed !== 'boolean' || !(test.exitCode === null || (typeof test.exitCode === 'number' && Number.isInteger(test.exitCode))) ||
          typeof test.stdout !== 'string' || typeof test.stderr !== 'string' ||
          typeof test.durationMs !== 'number' || !Number.isFinite(test.durationMs) || test.durationMs < 0 ||
          typeof test.checkedAt !== 'string' || !Number.isFinite(Date.parse(test.checkedAt))) return null
      if (test.contentSha256 !== undefined && (typeof test.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(test.contentSha256))) return null
    }
    if (record.install !== undefined) {
      if (!record.install || typeof record.install !== 'object' || Array.isArray(record.install)) return null
      const install = record.install as Record<string, unknown>
      if (typeof install.installed !== 'boolean' || typeof install.profile !== 'string' ||
          typeof install.installPath !== 'string' || typeof install.at !== 'string' || !Number.isFinite(Date.parse(install.at))) return null
      if (install.installed && !/^[a-zA-Z0-9_-]{1,64}$/.test(install.profile)) return null
    }
    if (record.active !== undefined) {
      if (!record.active || typeof record.active !== 'object' || Array.isArray(record.active)) return null
      const active = record.active as Record<string, unknown>
      if (typeof active.mounted !== 'boolean' || !Array.isArray(active.toolNames) ||
          !active.toolNames.every(v => typeof v === 'string') || typeof active.at !== 'string' ||
          !Number.isFinite(Date.parse(active.at))) return null
    }
    if (record.llmUsage !== undefined) {
      if (!record.llmUsage || typeof record.llmUsage !== 'object' || Array.isArray(record.llmUsage)) return null
      const usage = record.llmUsage as Record<string, unknown>
      if (!['inputTokens', 'outputTokens', 'totalTokens'].every(k =>
        typeof usage[k] === 'number' && Number.isFinite(usage[k]) && Number(usage[k]) >= 0)) return null
    }
    return value as ForgeRecord
  }

  /** Serialize record updates in this process so patches cannot overwrite each other. */
  async update(id: string, patch: Partial<ForgeRecord>): Promise<ForgeRecord | null> {
    if (!isSafeKey(id)) return null
    const previous = this.recordLocks.get(id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.recordLocks.set(id, current)
    await previous
    try {
      const existing = await this.get(id)
      if (!existing) return null
      const updated: ForgeRecord = { ...existing, ...patch, id, updatedAt: isoDateTime(this.nowFn()) }
      await writeJsonAtomic(join(this.recordsDir(), `${id}.json`), updated)
      return updated
    } finally {
      release()
      if (this.recordLocks.get(id) === current) this.recordLocks.delete(id)
    }
  }

  async list(limit = 50): Promise<ForgeRecord[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50
    const files = await listDir(this.recordsDir(), safeLimit * 2)
    const out: ForgeRecord[] = []
    for (const f of files) {
      const match = /^([a-f0-9]{12})\.json$/.exec(f)
      if (!match) continue
      const record = await this.get(match[1]!)
      if (record) out.push(record)
      if (out.length >= safeLimit) break
    }
    return out
  }
}
