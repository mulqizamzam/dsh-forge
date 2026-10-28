import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/host/index.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { HostContextShape, ToolDefinition } from '../src/host/dsh.ts'

function live<T>(read: () => T): { get: () => T } {
  return { get: read }
}

describe('modern DSH settings compatibility', () => {
  let root: string | undefined
  const originalDshHome = process.env.DSH_HOME

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
    vi.restoreAllMocks()
  })

  it('unwraps Volatile references afresh on each config read', () => {
    let defaultProfile = 'web'
    let timeoutMs = 60_000
    let allowInProcessExecution = false

    const configSource = {
      stateRoot: '',
      forge: {
        defaultProfile: live(() => defaultProfile),
        sandbox: {
          enabled: live(() => true),
          timeoutMs: live(() => timeoutMs),
        },
        install: {
          requireValidated: live(() => true),
          requireTested: live(() => true),
        },
        activation: {
          allowInProcessExecution: live(() => allowInProcessExecution),
        },
      },
    }

    const initial = resolveConfig(configSource)
    expect(initial.forge.defaultProfile).toBe('web')
    expect(initial.forge.sandbox.timeoutMs).toBe(60_000)
    expect(initial.forge.activation.allowInProcessExecution).toBe(false)

    defaultProfile = 'worker'
    timeoutMs = 12_000
    allowInProcessExecution = true

    const updated = resolveConfig(configSource)
    expect(updated.forge.defaultProfile).toBe('worker')
    expect(updated.forge.sandbox.timeoutMs).toBe(12_000)
    expect(updated.forge.activation.allowInProcessExecution).toBe(true)
    expect(typeof updated.forge.defaultProfile).toBe('string')
  })

  it('starts and registers every tool without the removed settings.register API', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-forge-settings-'))
    process.env.DSH_HOME = join(root, 'dsh-home')

    const registered: ToolDefinition[] = []
    const ctx: HostContextShape = {
      tools: { register: definition => { registered.push(definition) } },
      // DSH 0.1.7+ exposes SettingsForms here, not register().
      settings: { writable: true },
      get: () => undefined,
      on: () => () => {},
      effect: () => () => {},
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await apply(ctx, {})

    expect(registered).toHaveLength(13)
    expect(registered.map(tool => tool.name)).toContain('forge_reconcile')
    expect(registered.map(tool => tool.name)).toContain('forge_list')
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/settings\.register unavailable|boot failed|module registration incomplete/i)
  })

  it('continues to resolve plain configuration objects for legacy hosts and tests', () => {
    const resolved = resolveConfig({
      stateRoot: '/tmp/forge-state',
      forge: {
        defaultProfile: 'custom',
        sandbox: { enabled: false, timeoutMs: 5_000 },
        install: { requireValidated: true, requireTested: false },
        activation: { allowInProcessExecution: false },
      },
    })

    expect(resolved.stateRoot).toBe('/tmp/forge-state')
    expect(resolved.forge.defaultProfile).toBe('custom')
    expect(resolved.forge.sandbox.enabled).toBe(false)
    expect(resolved.forge.sandbox.timeoutMs).toBe(5_000)
    expect(resolved.forge.install.requireTested).toBe(false)
  })
})
