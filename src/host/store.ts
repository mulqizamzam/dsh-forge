import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
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

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await mkdir(join(this.root, 'records'), { recursive: true })
    await mkdir(join(this.root, 'installed'), { recursive: true })
    await mkdir(join(this.root, 'exports'), { recursive: true })
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
    return (await readJsonSafe(join(this.recordsDir(), `${id}.json`))) as ForgeRecord | null
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
    const files = await listDir(this.recordsDir(), limit)
    const out: ForgeRecord[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const r = await readJsonSafe(join(this.recordsDir(), f))
      if (r && typeof r === 'object') out.push(r as ForgeRecord)
    }
    return out
  }
}
