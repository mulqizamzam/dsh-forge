import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ForgeStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { forgeTools } from '../src/host/modules/forge/tools.ts'
import { validatePlugin, testInSandbox, pluginContentDigest, validateRuntimeToolDefinition } from '../src/host/modules/forge/actions.ts'
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
    expect(result.stdout.trimEnd().split(/\\r?\\n/).slice(-1)[0]).toBe('FORGE_SANDBOX_RESULT:OK:sandbox-smoke')
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

  it('does not follow symlinked record files', async () => {
    const outside = join(root, 'outside.json')
    await writeFile(outside, JSON.stringify({ id: 'secret-record', name: 'external-data' }))
    await symlink(outside, join(root, 'records', 'abcdef123456.json'))
    expect(await store.get('abcdef123456')).toBeNull()
    expect(await store.list()).toHaveLength(0)
  })
})
