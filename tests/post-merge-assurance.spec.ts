import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, readFile, appendFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { hostname, tmpdir } from 'node:os'
import { ForgeStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { forgeTools } from '../src/host/modules/forge/tools.ts'
import { TOOLS } from '../src/host/modules/forge/index.ts'
import { installPlugin, pluginContentDigest, validatePlugin } from '../src/host/modules/forge/actions.ts'
import { withFileLock } from '../src/lib/file-lock.ts'
import type { ModuleDeps, PluginFile } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'

function makeCtx(): HostContextShape {
  return {
    tools: { register: () => {} },
    settings: { writable: true, register: () => ({ get: () => ({}) }) },
    get: () => undefined,
    on: () => () => {},
    effect: () => () => {},
  }
}

function makeDeps(store: ForgeStore): ModuleDeps {
  return { ctx: makeCtx(), cfg: () => resolveConfig({}), store, log: () => {}, warn: () => {} }
}

function buildValidPluginFiles(name: string): PluginFile[] {
  const entry = `export function apply(ctx) {
  ctx.tools.register({
    name: '${name.replace(/-/g, '_')}_smoke',
    description: 'A self-contained regression fixture.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({ ok: true }),
  })
}`
  return [
    { path: 'package.json', content: JSON.stringify({
      name, version: '1.0.0', type: 'module',
      main: 'lib/index.js', exports: { '.': './lib/index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, engines: { dsh: '>=0.1.1-rc.1' } },
    }) },
    { path: 'cordis.patch.yml', content: `- insert:
    - id: ${name}
      name: ${name}
      config: {}` },
    { path: 'src/index.js', content: entry },
    { path: 'lib/index.js', content: entry },
  ]
}

async function addValidatedTestedRecord(store: ForgeStore, name: string) {
  const files = buildValidPluginFiles(name)
  const validation = validatePlugin(files)
  if (!validation.valid) throw new Error('fixture invalid: ' + validation.errors.join('; '))
  const record = await store.add({ name, description: 'post-merge assurance fixture', files })
  const digest = pluginContentDigest(files)!
  const checkedAt = new Date().toISOString()
  await store.update(record.id, {
    validation: { ...validation, checkedAt, contentSha256: digest },
    test: { passed: true, exitCode: 0, stdout: 'OK', stderr: '', durationMs: 1, checkedAt, contentSha256: digest },
  })
  return record
}

describe('post-merge hardening assurance', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'forge-assurance-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('keeps declared module tools in sync with the actual registration list', async () => {
    const store = new ForgeStore({ root })
    await store.init()
    const declared = [...TOOLS].sort()
    const actual = forgeTools(makeDeps(store)).map(tool => tool.name).sort()
    expect(declared).toEqual(actual)
    expect(declared).toContain('forge_reconcile')
  })

  it('removes the local install tree when the initial operation journal cannot be persisted', async () => {
    const store = new ForgeStore({ root })
    await store.init()
    const record = await addValidatedTestedRecord(store, 'journal-write-failure')
    const originalUpdate = store.update.bind(store)
    store.update = async (id, patch) => {
      if (patch.status === 'installing' && patch.operation?.kind === 'install') return null
      return originalUpdate(id, patch)
    }
    try {
      const result = await installPlugin(makeDeps(store), record.id, 'web')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/journal.*local install tree was cleaned/i)
      expect(await readdir(join(root, 'installed'))).not.toContain(record.id)
      const persisted = await store.get(record.id)
      expect(persisted?.operation).toBeUndefined()
      expect(persisted?.status).toBe('generated')
    } finally {
      store.update = originalUpdate
    }
  })

  it('serializes multiple processes reclaiming the same stale lock without overlapping critical sections', async () => {
    const lockPath = join(root, 'shared.lock')
    const readyPath = join(root, 'ready.log')
    const startPath = join(root, 'start')
    const tracePath = join(root, 'trace.log')
    const workerCount = 8
    await writeFile(lockPath, JSON.stringify({
      token: 'dead-owner-token-long-enough',
      pid: 999_999_999,
      host: hostname(),
      createdAt: Date.now() - 60_000,
    }))

    const lockModule = pathToFileURL(join(process.cwd(), 'src/lib/file-lock.ts')).href
    const workerSource = `
      import { appendFile } from 'node:fs/promises'
      import { existsSync } from 'node:fs'
      const { withFileLock } = await import(${JSON.stringify(lockModule)})
      const lockPath = process.env.FORGE_LOCK_PATH
      const readyPath = process.env.FORGE_READY_PATH
      const startPath = process.env.FORGE_START_PATH
      const tracePath = process.env.FORGE_TRACE_PATH
      if (!lockPath || !readyPath || !startPath || !tracePath) throw new Error('missing lock test environment')
      await appendFile(readyPath, 'ready ' + String(process.pid) + '\\n')
      while (!existsSync(startPath)) await new Promise(resolve => setTimeout(resolve, 5))
      await withFileLock(lockPath, async () => {
        await appendFile(tracePath, 'enter ' + String(process.pid) + '\\n')
        await new Promise(resolve => setTimeout(resolve, 45))
        await appendFile(tracePath, 'exit ' + String(process.pid) + '\\n')
      }, { timeoutMs: 15000 })
    `

    const childPromises: Promise<void>[] = []
    for (let i = 0; i < workerCount; i++) {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', workerSource], {
        env: {
          ...process.env,
          FORGE_LOCK_PATH: lockPath,
          FORGE_READY_PATH: readyPath,
          FORGE_START_PATH: startPath,
          FORGE_TRACE_PATH: tracePath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      childPromises.push(new Promise<void>((resolve, reject) => {
        let stderr = ''
        child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 4000) })
        child.once('error', reject)
        child.once('close', code => {
          if (code === 0) resolve()
          else reject(new Error('lock worker failed (' + String(code) + '): ' + stderr))
        })
      }))
    }

    const readyDeadline = Date.now() + 5_000
    let readyCount = 0
    while (Date.now() < readyDeadline) {
      const ready = await readFile(readyPath, 'utf8').catch(() => '')
      readyCount = ready.trim() ? ready.trim().split(/\\r?\\n/).length : 0
      if (readyCount >= workerCount) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(readyCount).toBe(workerCount)
    await writeFile(startPath, 'go')
    await Promise.all(childPromises)

    const events = (await readFile(tracePath, 'utf8')).trim().split(/\\r?\\n/).map(line => line.split(' '))
    expect(events).toHaveLength(workerCount * 2)
    let activePid: string | null = null
    for (const [action, pid] of events) {
      if (action === 'enter') {
        expect(activePid).toBeNull()
        activePid = pid ?? null
      } else {
        expect(action).toBe('exit')
        expect(activePid).toBe(pid)
        activePid = null
      }
    }
    expect(activePid).toBeNull()
  })

  it('fails closed when a stale lock recovery marker already exists', async () => {
    const lockPath = join(root, 'blocked.lock')
    const ownerToken = 'stale-owner-token-long-enough'
    await writeFile(lockPath, JSON.stringify({
      token: ownerToken,
      pid: 999_999_999,
      host: hostname(),
      createdAt: Date.now() - 60_000,
    }))
    const recoveryPath = lockPath + '.recovery'
    await writeFile(recoveryPath, JSON.stringify({ token: 'operator-review-required' }))

    let ran = false
    await expect(withFileLock(lockPath, async () => { ran = true }, { timeoutMs: 100 }))
      .rejects.toThrow(/recovery marker exists/i)
    expect(ran).toBe(false)
    expect(JSON.parse(await readFile(lockPath, 'utf8')).token).toBe(ownerToken)
    expect(JSON.parse(await readFile(recoveryPath, 'utf8')).token).toBe('operator-review-required')
  })
})
