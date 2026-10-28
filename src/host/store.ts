import { join, resolve, parse, relative, sep } from 'node:path'
import { mkdir, lstat, chmod } from 'node:fs/promises'
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

  constructor(opts: ForgeStoreOptions) {
    this.root = opts.root
    this.nowFn = opts.now ?? (() => new Date())
  }

  getRoot(): string { return this.root }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
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
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error('stateRoot must be a real directory, not a symlink')
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
    if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return null
    if (!['generated', 'validated', 'tested', 'installed', 'active', 'failed'].includes(String(record.status))) return null
    return value as ForgeRecord
  }

  async update(id: string, patch: Partial<ForgeRecord>): Promise<ForgeRecord | null> {
    if (!isSafeKey(id)) return null
    const existing = await this.get(id)
    if (!existing) return null
    const updated: ForgeRecord = { ...existing, ...patch, id, updatedAt: isoDateTime(this.nowFn()) }
    await writeJsonAtomic(join(this.recordsDir(), `${id}.json`), updated)
    return updated
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
