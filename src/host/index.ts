import { join } from 'node:path'
import { neutralize } from '../lib/sanitize.ts'
import { Config, DEFAULT_CONFIG, resolveConfig } from './config.ts'
import type { ForgeConfig } from './config.ts'
import { ForgeStore } from './store.ts'
import type { ModuleDeps } from './types.ts'
import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from './dsh.ts'
import type { HostContextShape } from './dsh.ts'
import * as forgeModule from './modules/forge/index.ts'
import * as stateModule from './modules/state/index.ts'

export const name = 'dsh-forge'

declare const PKG_VERSION: string
export const VERSION = typeof PKG_VERSION === 'string' && PKG_VERSION !== ''
  ? PKG_VERSION
  : '0.2.0'

export const inject = ['tools', 'settings']

export interface ForgeModule {
  name: string
  apply: (deps: ModuleDeps) => void
}

export const MODULES: ForgeModule[] = [forgeModule, stateModule] as unknown as ForgeModule[]

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === 'string' ? e : String(e)
}

interface Logger { info: (m: string) => void; warn: (m: string) => void }
function makeLogger(_prefix: string): Logger {
  return { info: () => {}, warn: () => {} }
}

export async function apply(rawContext: unknown, rawConfig: Partial<ForgeConfig> = {}): Promise<void> {
  const log = makeLogger('dsh-forge')
  const ctx = rawContext as HostContextShape
  try {
    await boot(ctx, rawConfig, log)
    log.info('ready: ' + MODULES.map(m => m.name).join(', '))
  } catch (error) {
    const detail = errorMessage(error)
    log.warn('boot failed: ' + detail)
    try {
      registerToolSafe(ctx, defineTool({
        name: 'forge_status',
        description: 'dsh-forge failed to start; reports why. No other forge_* tool is available this session.',
        parameters: { type: 'object', properties: {} },
        output: { schema: JSON_OBJECT_OUTPUT, render: (_a, v) => text(v) },
        execute: async () => ({
          plugin: 'dsh-forge',
          state: 'failed',
          error: neutralize(detail),
        }),
      } as never))
    } catch { /* ignore */ }
  }
}

async function boot(
  ctx: HostContextShape,
  rawConfig: Partial<ForgeConfig>,
  log: Logger,
): Promise<void> {
  let resolved = resolveConfig(rawConfig)
  try {
    const scope = ctx.settings.register<ForgeConfig>('dsh-forge', Config, {
      base: rawConfig as ForgeConfig,
      applies: 'live',
    })
    try { resolved = resolveConfig(scope.get()) } catch (e) {
      log.warn('settings scope read failed: ' + errorMessage(e))
    }
  } catch (e) {
    log.warn('settings.register unavailable: ' + errorMessage(e))
  }
  try {
    ctx.on('settings/updated', ((ns: string, next: ForgeConfig) => {
      if (ns !== 'dsh-forge') return
      try { resolved = resolveConfig(next); log.info('config swapped (live)') } catch (e) {
        log.warn('config swap failed: ' + errorMessage(e))
      }
    }) as never)
  } catch { /* non-fatal */ }

  let profileName: string | undefined
  try {
    const baseUrl = (ctx as { baseUrl?: unknown }).baseUrl
    if (typeof baseUrl === 'string' && baseUrl !== '') {
      const parts = new URL(baseUrl).pathname.split('/')
      const idx = parts.lastIndexOf('profiles')
      if (idx >= 0 && idx + 1 < parts.length) {
        const candidate = parts[idx + 1]
        if (candidate && /^[a-z0-9_-]+$/.test(candidate)) profileName = candidate
      }
    }
  } catch { /* ignore */ }

  let base: string
  if (resolved.stateRoot !== '') {
    base = resolved.stateRoot
  } else {
    let fromService: string | undefined
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
      if (typeof svc === 'function') {
        const v = (svc as (n: string) => string)('dsh-forge')
        if (typeof v === 'string' && v !== '') fromService = v
      }
    } catch { /* ignore */ }
    if (fromService) base = fromService
    else {
      const envHome = process.env.DSH_HOME
      if (envHome && envHome.trim() !== '') base = join(envHome.trim(), 'dsh-forge')
      else {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
        base = join(home, '.dsh', 'dsh-forge')
      }
    }
  }
  const root = profileName ? join(base, profileName) : base

  const store = new ForgeStore({ root })
  await store.init()
  log.info('state at ' + root)

  const cfg = () => resolved
  const deps: ModuleDeps = {
    ctx,
    cfg,
    store,
    log: (m: string) => log.info(m),
    warn: (m: string) => log.warn(m),
  }

  for (const module of MODULES) {
    try { module.apply(deps) } catch (e) {
      log.warn('module "' + module.name + '" failed: ' + errorMessage(e))
    }
  }
}

export { Config, DEFAULT_CONFIG, resolveConfig, ForgeStore }
