import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod, symlink, readdir } from 'node:fs/promises'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeStore } from '../src/host/store.ts'
import { readJsonSafe, writeJsonAtomic } from '../src/lib/fsx.ts'
import { resolveConfig } from '../src/host/config.ts'
import { forgeTools } from '../src/host/modules/forge/tools.ts'
import { validatePlugin, testInSandbox, pluginContentDigest, validateRuntimeToolDefinition, installPlugin, activatePlugin, deactivatePlugin, exportPlugin } from '../src/host/modules/forge/actions.ts'
import type { ModuleDeps } from '../src/host/types.ts'
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

describe('dsh-forge smoke', () => {
  let root: string
  let store: ForgeStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-'))
    store = new ForgeStore({ root })
    await store.init()
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('registers 10 forge action tools', () => {
    const tools = forgeTools(makeDeps(store))
    expect(tools.length).toBe(10)
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual([
      'forge_activate',
      'forge_deactivate',
      'forge_discover',
      'forge_export',
      'forge_generate',
      'forge_install',
      'forge_submit',
      'forge_test',
      'forge_uninstall',
      'forge_validate',
    ])
  })

  it('validate rejects plugin missing dsh.bundle.patch', () => {
    const result = validatePlugin([
      { path: 'package.json', content: '{"name":"x","version":"1.0.0","type":"module","main":"lib/index.js","exports":{".":"./lib/index.js"}}' },
      { path: 'cordis.patch.yml', content: '- insert: []' },
      { path: 'src/index.js', content: 'export function apply(ctx) { ctx.tools.register({ name: "t", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }) }' },
      { path: 'lib/index.js', content: 'export function apply(ctx) { ctx.tools.register({ name: "t", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }) }' },
    ])
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toMatch(/dsh/i)
  })

  it('validate rejects plugin missing insert: block', () => {
    const result = validatePlugin([
      { path: 'package.json', content: '{"name":"x","version":"1.0.0","type":"module","main":"lib/index.js","exports":{".":"./lib/index.js"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}' },
      { path: 'cordis.patch.yml', content: 'garbage' },
      { path: 'src/index.js', content: 'export function apply(ctx) { ctx.tools.register({ name: "t", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }) }' },
      { path: 'lib/index.js', content: 'export function apply(ctx) { ctx.tools.register({ name: "t", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }) }' },
    ])
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toMatch(/insert/)
  })

  it('validate rejects plugin missing apply export', () => {
    const result = validatePlugin([
      { path: 'package.json', content: '{"name":"x","version":"1.0.0","type":"module","main":"lib/index.js","exports":{".":"./lib/index.js"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}' },
      { path: 'cordis.patch.yml', content: '- insert: []' },
      { path: 'src/index.js', content: 'export const x = 1' },
      { path: 'lib/index.js', content: 'export const x = 1' },
    ])
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toMatch(/apply/)
  })

  it('validate rejects unsafe path traversal', () => {
    const result = validatePlugin([
      { path: '../evil.js', content: 'x' },
      { path: 'package.json', content: '{"name":"x","version":"1.0.0","type":"module","main":"lib/index.js","exports":{".":"./lib/index.js"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}' },
      { path: 'cordis.patch.yml', content: '- insert: []' },
      { path: 'src/index.js', content: 'export function apply(ctx) { ctx.tools.register({ name: "t", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }) }' },
      { path: 'lib/index.js', content: 'export function apply(ctx) { ctx.tools.register({ name: "t", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }) }' },
    ])
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toMatch(/unsafe file path/)
  })

  it('validate rejects file over 1 MiB', () => {
    const bigContent = 'x'.repeat(2 * 1024 * 1024)
    const result = validatePlugin([
      { path: 'package.json', content: '{"name":"x","version":"1.0.0","type":"module","main":"lib/index.js","exports":{".":"./lib/index.js"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}' },
      { path: 'cordis.patch.yml', content: '- insert: []' },
      { path: 'src/index.js', content: 'export function apply(ctx) { ctx.tools.register({ name: "t", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }) }' },
      { path: 'lib/index.js', content: 'export function apply(ctx) { ctx.tools.register({ name: "t", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }) }' },
      { path: 'assets/big.txt', content: bigContent },
    ])
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toMatch(/MiB/)
  })

  it('rejects source/runtime entry drift', () => {
    const entry = 'export function apply(ctx) { ctx.tools.register({ name: "t" }) }'
    const result = validatePlugin([
      { path: 'package.json', content: '{"name":"x","version":"1.0.0","type":"module","main":"lib/index.js","exports":{".":"./lib/index.js"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}' },
      { path: 'cordis.patch.yml', content: '- insert:\\n    - id: x\\n      name: x\\n      config: {}' },
      { path: 'src/index.js', content: entry },
      { path: 'lib/index.js', content: entry + '\\n// drift' },
    ])
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toMatch(/identical/i)
  })

  it('validate accepts well-formed plugin', () => {
    const result = validatePlugin([
      { path: 'package.json', content: '{"name":"x","version":"1.0.0","type":"module","main":"lib/index.js","exports":{".":"./lib/index.js"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"},"engines":{"dsh":">=0.1.1-rc.1"}}}' },
      { path: 'cordis.patch.yml', content: '- insert:\n    - id: x\n      name: x\n      config: {}' },
      { path: 'src/index.js', content: 'export function apply(ctx) { ctx.tools.register({ name: "t", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }) }' },
      { path: 'lib/index.js', content: 'export function apply(ctx) { ctx.tools.register({ name: "t", description: "d", parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => ({}) }) }' },
    ])
    expect(result.valid).toBe(true)
  })
})

describe('dsh-forge install gate', () => {
  let root: string
  let store: ForgeStore
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-'))
    store = new ForgeStore({ root })
    await store.init()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('install refuses without validation', async () => {
    const record = await store.add({ name: 'test', description: 'd', files: [] })
    const { installPlugin } = await import('../src/host/modules/forge/actions.ts')
    const result = await installPlugin(makeDeps(store), record.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/validation/i)
  })

  it('activate refuses without validation + test', async () => {
    const record = await store.add({ name: 'test', description: 'd', files: [] })
    const { activatePlugin } = await import('../src/host/modules/forge/actions.ts')
    const result = await activatePlugin(makeDeps(store), record.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/validation/i)
  })

  it('retains a mounted Fiber after disposal fails so deactivation can retry', async () => {
    const { activatePlugin, deactivatePlugin } = await import('../src/host/modules/forge/actions.ts')
    const entry = `export function apply(ctx) {
  ctx.tools.register({
    name: 'active_smoke',
    description: 'A valid tool used to test activation cleanup.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({ ok: true }),
  })
}`
    const files = [
      { path: 'package.json', content: JSON.stringify({
        name: 'active-smoke', version: '1.0.0', type: 'module',
        main: 'lib/index.js', exports: { '.': './lib/index.js' },
        dsh: { bundle: { patch: './cordis.patch.yml' }, engines: { dsh: '>=0.1.1-rc.1' } },
      }) },
      { path: 'cordis.patch.yml', content: '- insert:\n    - id: active-smoke\n      name: active-smoke\n      config: {}' },
      { path: 'src/index.js', content: entry },
      { path: 'lib/index.js', content: entry },
    ]
    const validation = validatePlugin(files)
    expect(validation.valid).toBe(true)
    const record = await store.add({ name: 'active-smoke', description: 'activation cleanup regression', files })
    const digest = pluginContentDigest(files)!
    const checkedAt = new Date().toISOString()
    await store.update(record.id, {
      validation: { ...validation, checkedAt, contentSha256: digest },
      test: { passed: true, exitCode: 0, stdout: 'OK', stderr: '', durationMs: 1, checkedAt, contentSha256: digest },
    })

    const ctx = makeCtx()
    let disposeCalls = 0
    ctx.plugin = (module: unknown) => {
      const pluginModule = module as { apply?: (host: HostContextShape, config: unknown) => unknown }
      pluginModule.apply?.(ctx, {})
      return {
        state: 'ACTIVE',
        inertia: Promise.resolve(),
        dispose: () => {
          disposeCalls++
          if (disposeCalls === 1) throw new Error('transient dispose failure')
        },
      }
    }
    const deps = makeDeps(store)
    deps.ctx = ctx
    const originalUpdate = store.update.bind(store)
    store.update = async (id, patch) => {
      if (patch.status === 'active') return null
      return originalUpdate(id, patch)
    }

    let activation: Awaited<ReturnType<typeof activatePlugin>>
    try {
      activation = await activatePlugin(deps, record.id)
    } finally {
      store.update = originalUpdate
    }
    const deactivation = await deactivatePlugin(deps, record.id)
    expect(activation.ok).toBe(false)
    if (!activation.ok) expect(activation.error).toMatch(/cleanup also failed/i)
    expect(deactivation.ok).toBe(true)
    expect(disposeCalls).toBe(2)
  })

  it('buildSubmissionListing extracts capabilities from src/index.js', async () => {
    const { buildSubmissionListing } = await import('../src/host/modules/forge/actions.ts')
    const record = await store.add({
      name: 'demo',
      description: 'Demo plugin',
      files: [
        { path: 'package.json', content: '{"name":"demo","version":"1.2.3"}' },
        { path: 'src/index.js', content: 'export function apply(ctx) { ctx.tools.register({ name: "foo" }); ctx.tools.register({ name: "bar" }); }' },
      ],
    })
    const listing = buildSubmissionListing(record, {})
    expect(listing.packageName).toBe('demo')
    expect(listing.version).toBe('1.2.3')
    expect(listing.capabilities).toContain('foo')
    expect(listing.capabilities).toContain('bar')
  })
})

describe('path and package hardening', () => {
  it('rejects Windows and ambiguous paths', async () => {
    const { containPath } = await import('../src/lib/contain.ts')
    expect(containPath('/safe/root', 'C:\\Windows\\win.ini')).toBeNull()
    expect(containPath('/safe/root', 'src\\..\\outside.js')).toBeNull()
    expect(containPath('/safe/root', 'src/../outside.js')).toBeNull()
    expect(containPath('/safe/root', 'src//index.js')).toBeNull()
    expect(containPath('/safe/root', 'src/index.js')).not.toBeNull()
  })

  it('rejects duplicate package paths and reserved secret paths', () => {
    const validPackage = '{"name":"x","version":"1.0.0","type":"module","main":"lib/index.js","exports":{".":"./lib/index.js"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}'
    const entry = 'export function apply(ctx) { ctx.tools.register({ name: "t" }) }'
    const result = validatePlugin([
      { path: 'package.json', content: validPackage },
      { path: 'cordis.patch.yml', content: '- insert:\n    - id: x\n      name: x\n      config: {}' },
      { path: 'src/index.js', content: entry },
      { path: 'lib/index.js', content: entry },
      { path: '.env', content: 'TOKEN=secret' },
      { path: 'lib/index.js', content: entry },
    ])
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toMatch(/duplicate file path/i)
    expect(result.errors.join(' ')).toMatch(/sensitive|vendor/i)
  })

  it('requires package main entry and registry identity to match', () => {
    const entry = 'export function apply(ctx) { ctx.tools.register({ name: "t" }) }'
    const result = validatePlugin([
      { path: 'package.json', content: '{"name":"one","version":"1.0.0","main":"missing.js","exports":{".":"./missing.js"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}' },
      { path: 'cordis.patch.yml', content: '- insert:\n    - id: another\n      name: another\n      config: {}' },
      { path: 'src/index.js', content: entry },
      { path: 'lib/index.js', content: entry },
    ])
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toMatch(/main|exports|match/i)
  })
})

describe('hardening regressions', () => {
  it('rejects a fake apply export hidden in a comment', () => {
    const pkg = '{"name":"x","version":"1.0.0","type":"module","main":"lib/index.js","exports":{".":"./lib/index.js"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"},"engines":{"dsh":">=0.1.1-rc.1"}}}'
    const code = '// export function apply(ctx) { ctx.tools.register({ name: "fake" }) }\nexport const value = 1'
    const result = validatePlugin([
      { path: 'package.json', content: pkg },
      { path: 'cordis.patch.yml', content: '- insert:\n    - id: x\n      name: x\n      config: {}' },
      { path: 'src/index.js', content: code },
      { path: 'lib/index.js', content: code },
    ])
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toMatch(/apply|register/i)
  })

  it('rejects malformed file collections without throwing', () => {
    expect(validatePlugin(null).valid).toBe(false)
    expect(validatePlugin([null]).errors.join(' ')).toMatch(/file must be an object/i)
    expect(validatePlugin([{ path: 'x.js', content: 42 }]).errors.join(' ')).toMatch(/string path and content/i)
  })

  it('rejects file-versus-directory path collisions', () => {
    const pkg = '{"name":"x","version":"1.0.0","type":"module","main":"lib/index.js","exports":{".":"./lib/index.js"},"dsh":{"bundle":{"patch":"./cordis.patch.yml"},"engines":{"dsh":">=0.1.1-rc.1"}}}'
    const entry = 'export function apply(ctx) { ctx.tools.register({ name: "t" }) }'
    const result = validatePlugin([
      { path: 'package.json', content: pkg },
      { path: 'cordis.patch.yml', content: '- insert:\n    - id: x\n      name: x\n      config: {}' },
      { path: 'src/index.js', content: entry },
      { path: 'lib/index.js', content: entry },
      { path: 'assets', content: 'file' },
      { path: 'assets/logo.svg', content: 'child' },
    ])
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toMatch(/path conflicts/i)
  })

  it('binds test evidence to stable content digests', () => {
    const original = [{ path: 'a.js', content: 'a' }, { path: 'b.js', content: 'b' }]
    expect(pluginContentDigest(original)).toBe(pluginContentDigest([...original].reverse()))
    expect(pluginContentDigest(original)).not.toBe(pluginContentDigest([{ path: 'a.js', content: 'changed' }, original[1]]))
    expect(pluginContentDigest([{ path: 'a.js', content: 1 }])).toBeNull()
  })
})

describe('runtime tool contract hardening', () => {
  const validTool = {
    name: 'tool_smoke',
    description: 'A minimal valid DSH tool.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({ ok: true }),
  }

  it('accepts a complete runtime tool definition', () => {
    expect(validateRuntimeToolDefinition(validTool)).toEqual({ valid: true, name: 'tool_smoke' })
  })

  it('rejects name-only registrations that used to make the sandbox pass', () => {
    const result = validateRuntimeToolDefinition({ name: 'looks-valid' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toMatch(/description|parameters|output|execute/i)
  })

  it('rejects malformed schemas, missing execute handlers, and invalid names', () => {
    expect(validateRuntimeToolDefinition({ ...validTool, parameters: [] }).valid).toBe(false)
    expect(validateRuntimeToolDefinition({ ...validTool, execute: undefined }).valid).toBe(false)
    expect(validateRuntimeToolDefinition({ ...validTool, name: 'bad tool name' }).valid).toBe(false)
  })
})

describe('runtime sandbox', () => {
  it('runs the runtime entry inside an isolated bubblewrap filesystem', async () => {
    const entry = `import { existsSync, writeFileSync } from 'node:fs'
export async function apply(ctx) {
  if (existsSync('/home')) throw new Error('host home directory is visible in sandbox')
  if (process.env.DSH_HOME) throw new Error('host DSH_HOME leaked into sandbox')
  try {
    writeFileSync('.sandbox-write-probe', 'must not write')
    throw new Error('plugin source tree is writable in sandbox')
  } catch (error) {
    if (error && error.message === 'plugin source tree is writable in sandbox') throw error
    if (!error || !['EROFS', 'EACCES'].includes(error.code)) throw error
  }
  ctx.tools.register({
    name: 'sandbox-smoke',
    description: 'Validate sandbox isolation and registration shape.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({ ok: true }),
  })
}`
    const files = [
      { path: 'package.json', content: '{"name":"sandbox-smoke","type":"module","main":"lib/index.js"}' },
      { path: 'src/index.js', content: entry },
      { path: 'lib/index.js', content: entry },
    ]
    const result = await testInSandbox({} as ModuleDeps, files, 15_000)
    if (!result.passed) {
      // Hosted runners may prohibit creating/configuring a user network namespace.
      // The production tool must fail closed; this branch does NOT claim the
      // candidate plugin was executed or sandbox-tested successfully.
      expect(result.stderr).toMatch(/bwrap not available|RTM_NEWADDR: Operation not permitted|No permissions to create a new namespace|Operation not permitted/i)
      expect(result.passed).toBe(false)
      return
    }
    expect(result.stdout.trimEnd().split(/\r?\n/).slice(-1)[0]).toBe('FORGE_SANDBOX_RESULT:OK:sandbox-smoke')
  })

})

describe('dsh-forge store', () => {
  let root: string
  let store: ForgeStore
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-'))
    store = new ForgeStore({ root })
    await store.init()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('add returns a record with generated status and id', async () => {
    const rec = await store.add({ name: 'x', description: 'd', files: [{ path: 'a.js', content: 'x' }] })
    expect(rec.id).toMatch(/^[0-9a-f]{12}$/)
    expect(rec.status).toBe('generated')
  })

  it('get returns null for unsafe id', async () => {
    expect(await store.get('../evil')).toBeNull()
    expect(await store.get('/etc/passwd')).toBeNull()
  })

  it('update preserves id and updates updatedAt', async () => {
    const rec = await store.add({ name: 'x', description: 'd', files: [] })
    const updated = await store.update(rec.id, { status: 'validated' })
    expect(updated?.id).toBe(rec.id)
    expect(updated?.status).toBe('validated')
  })

  it('serializes concurrent disjoint record updates without losing fields', async () => {
    const rec = await store.add({ name: 'x', description: 'd', files: [] })
    await Promise.all([
      store.update(rec.id, { validation: { valid: true, errors: [], warnings: [], checkedAt: '2026-01-01T00:00:00.000Z' } }),
      store.update(rec.id, { test: { passed: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1, checkedAt: '2026-01-01T00:00:00.000Z' } }),
    ])
    const after = await store.get(rec.id)
    expect(after?.validation?.valid).toBe(true)
    expect(after?.test?.passed).toBe(true)
  })

  it('cleans up temporary files when JSON serialization fails', async () => {
    await expect(writeJsonAtomic(join(root, 'records', 'bad.json'), undefined)).rejects.toThrow(/serialize undefined/i)
    const entries = await readdir(join(root, 'records'))
    expect(entries.some(entry => entry.includes('.tmp.'))).toBe(false)
  })

  it('does not follow symlinked record files', async () => {
    const outside = join(root, 'outside.json')
    await writeFile(outside, JSON.stringify({ id: 'secret-record', name: 'external-data' }))
    await symlink(outside, join(root, 'records', 'abcdef123456.json'))
    expect(await store.get('abcdef123456')).toBeNull()
    expect(await store.list()).toHaveLength(0)
  })
})


describe('symlink and TOCTOU hardening', () => {
  let root: string
  let outside: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-safe-'))
    outside = await mkdtemp(join(tmpdir(), 'forge-outside-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('readJsonSafe refuses a symlink instead of reading its target', async () => {
    const target = join(outside, 'record.json')
    const link = join(root, 'record.json')
    await writeFile(target, JSON.stringify({ secret: true }))
    await symlink(target, link)
    expect(await readJsonSafe(link)).toBeNull()
  })

  it('store init rejects a state root reached through a symlinked parent', async () => {
    const link = join(root, 'linked-parent')
    await symlink(outside, link)
    const store = new ForgeStore({ root: join(link, 'state') })
    await expect(store.init()).rejects.toThrow(/symlink/i)
  })

  it('store init rejects a symlinked state root', async () => {
    const link = join(root, 'state-link')
    await symlink(outside, link)
    const store = new ForgeStore({ root: link })
    await expect(store.init()).rejects.toThrow(/symlink/i)
  })
})


describe('lifecycle and persisted-state hardening', () => {
  let root: string
  let store: ForgeStore
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-lifecycle-'))
    store = new ForgeStore({ root })
    await store.init()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('rejects records with malformed nested validation state', async () => {
    const record = await store.add({ name: 'x', description: 'd', files: [] })
    const recordPath = join(root, 'records', record.id + '.json')
    const malformed = { ...record, validation: { valid: 'yes', errors: [], warnings: [], checkedAt: 'not-a-date' } }
    await writeFile(recordPath, JSON.stringify(malformed))
    expect(await store.get(record.id)).toBeNull()
  })
  it('preserves an existing archive and removes staging files when tar fails', async () => {
    const record = await store.add({
      name: 'export-failure',
      description: 'export cleanup regression',
      files: [{ path: 'package.json', content: '{"name":"export-failure","version":"1.0.0"}' }],
    })
    const exportsDir = join(root, 'exports')
    const archivePath = join(exportsDir, `export-failure-${record.id}.tgz`)
    const sentinel = 'existing-archive-must-survive'
    await writeFile(archivePath, sentinel)

    const fakeBin = join(root, 'fake-bin')
    await mkdir(fakeBin)
    await writeFile(join(fakeBin, 'tar'), '#!/bin/sh\nprintf "forced tar failure\\n" >&2\nexit 19\n')
    await chmod(join(fakeBin, 'tar'), 0o700)

    const previousPath = process.env.PATH
    process.env.PATH = [fakeBin, previousPath].filter((part): part is string => typeof part === 'string' && part !== '').join(delimiter)
    let result: Awaited<ReturnType<typeof exportPlugin>>
    try {
      result = await exportPlugin(makeDeps(store), record.id)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/tar failed/i)
    expect(await readFile(archivePath, 'utf8')).toBe(sentinel)
    expect((await readdir(exportsDir)).filter(name => name.endsWith('.tmp.tgz'))).toEqual([])
  })


  it('serializes lifecycle operations per record and releases the guard after failure', async () => {
    const entry = `export function apply(ctx) {
  ctx.tools.register({
    name: 'lifecycle_smoke',
    description: 'A valid tool for lifecycle concurrency regression coverage.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({ ok: true }),
  })
}`
    const files = [
      { path: 'package.json', content: JSON.stringify({
        name: 'lifecycle-smoke', version: '1.0.0', type: 'module',
        main: 'lib/index.js', exports: { '.': './lib/index.js' },
        dsh: { bundle: { patch: './cordis.patch.yml' }, engines: { dsh: '>=0.1.1-rc.1' } },
      }) },
      { path: 'cordis.patch.yml', content: '- insert:\n    - id: lifecycle-smoke\n      name: lifecycle-smoke\n      config: {}' },
      { path: 'src/index.js', content: entry },
      { path: 'lib/index.js', content: entry },
    ]
    const validation = validatePlugin(files)
    expect(validation.valid).toBe(true)
    const record = await store.add({ name: 'lifecycle-smoke', description: 'lifecycle race regression', files })
    const digest = pluginContentDigest(files)!
    const checkedAt = new Date().toISOString()
    await store.update(record.id, {
      validation: { ...validation, checkedAt, contentSha256: digest },
      test: { passed: true, exitCode: 0, stdout: 'OK', stderr: '', durationMs: 1, checkedAt, contentSha256: digest },
    })

    const ctx = makeCtx()
    let mountCount = 0
    let signalFirstMount!: () => void
    const firstMount = new Promise<void>(resolve => { signalFirstMount = resolve })
    let failFirstMount!: (reason?: Error) => void
    const blockedInertia = new Promise<void>((_resolve, reject) => { failFirstMount = reject })
    ctx.plugin = (module: unknown) => {
      const pluginModule = module as { apply?: (host: HostContextShape, config: unknown) => unknown }
      pluginModule.apply?.(ctx, {})
      mountCount++
      if (mountCount === 1) signalFirstMount()
      return {
        state: 'ACTIVE',
        inertia: mountCount === 1 ? blockedInertia : Promise.resolve(),
        dispose: () => {},
      }
    }
    const deps = makeDeps(store)
    deps.ctx = ctx

    const firstActivation = activatePlugin(deps, record.id)
    await firstMount
    const overlappingDeactivation = await deactivatePlugin(deps, record.id)
    expect(overlappingDeactivation.ok).toBe(false)
    if (!overlappingDeactivation.ok) {
      expect(overlappingDeactivation.error).toMatch(/lifecycle operation is already in progress/i)
    }

    // Force the first operation down its error path, then prove its finally
    // released the per-record guard by activating successfully on the retry.
    failFirstMount(new Error('simulated transient mount failure'))
    const failedActivation = await firstActivation
    expect(failedActivation.ok).toBe(false)
    if (!failedActivation.ok) expect(failedActivation.error).toMatch(/mount failed/i)

    const retryActivation = await activatePlugin(deps, record.id)
    expect(retryActivation.ok).toBe(true)
    expect(mountCount).toBe(2)
    const deactivation = await deactivatePlugin(deps, record.id)
    expect(deactivation.ok).toBe(true)
  })
})
