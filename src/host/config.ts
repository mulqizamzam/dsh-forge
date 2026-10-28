import Schema from '@deepseek-ai/schemastery'

/** Minimal structural view of a DSH live-config reference. */
export interface VolatileValue<T> {
  get(): T
}

export interface ForgeRuntimeConfig {
  /** Restart-only: the file-backed store is opened once during plugin boot. */
  stateRoot: string
  forge: {
    defaultProfile: VolatileValue<string>
    sandbox: {
      enabled: VolatileValue<boolean>
      timeoutMs: VolatileValue<number>
    }
    install: {
      requireValidated: VolatileValue<boolean>
      requireTested: VolatileValue<boolean>
    }
    activation: {
      allowInProcessExecution: VolatileValue<boolean>
    }
  }
}

/** Plain resolved values consumed by Forge actions. */
export interface ForgeConfig {
  stateRoot: string
  forge: {
    defaultProfile: string
    sandbox: { enabled: boolean; timeoutMs: number }
    install: { requireValidated: boolean; requireTested: boolean }
    activation: { allowInProcessExecution: boolean }
  }
}

export const DEFAULT_CONFIG: ForgeConfig = {
  stateRoot: '',
  forge: {
    defaultProfile: 'web',
    sandbox: { enabled: true, timeoutMs: 60_000 },
    install: { requireValidated: true, requireTested: true },
    activation: { allowInProcessExecution: false },
  },
}

/**
 * DSH 0.1.7+ builds the settings form from the exported Config schema.
 * Mark live editable fields volatile; stateRoot intentionally remains ordinary
 * config because the store's root is fixed during boot and changing it requires
 * a plugin restart.
 */
export const Config = Schema.object({
  stateRoot: Schema.string().default(DEFAULT_CONFIG.stateRoot),
  forge: Schema.object({
    defaultProfile: Schema.string().default(DEFAULT_CONFIG.forge.defaultProfile).volatile(),
    sandbox: Schema.object({
      enabled: Schema.boolean().default(DEFAULT_CONFIG.forge.sandbox.enabled).volatile(),
      timeoutMs: Schema.number().default(DEFAULT_CONFIG.forge.sandbox.timeoutMs).volatile(),
    }).default(DEFAULT_CONFIG.forge.sandbox),
    install: Schema.object({
      requireValidated: Schema.boolean().default(DEFAULT_CONFIG.forge.install.requireValidated).volatile(),
      requireTested: Schema.boolean().default(DEFAULT_CONFIG.forge.install.requireTested).volatile(),
    }).default(DEFAULT_CONFIG.forge.install),
    activation: Schema.object({
      allowInProcessExecution: Schema.boolean().default(DEFAULT_CONFIG.forge.activation.allowInProcessExecution).volatile(),
    }).default(DEFAULT_CONFIG.forge.activation),
  }).default(DEFAULT_CONFIG.forge),
})

export type ResolvedConfig = ForgeConfig

/**
 * New DSH loaders supply Volatile<T> references for fields marked volatile.
 * Unwrap those references immediately before schema validation. Resolve on each
 * call so callers see live edits rather than a stale boot-time snapshot.
 */
function unwrapVolatile(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value

  const candidate = value as { get?: unknown }
  if (typeof candidate.get === 'function') {
    return unwrapVolatile(candidate.get.call(value))
  }

  if (Array.isArray(value)) return value.map(unwrapVolatile)

  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    output[key] = unwrapVolatile(child)
  }
  return output
}

export function resolveConfig(raw: unknown): ResolvedConfig {
  // Schemastery may materialize .volatile() fields as references while applying
  // defaults. Unwrap both the loader-provided config and the parsed result.
  const parsed = Config(unwrapVolatile(raw) as Parameters<typeof Config>[0])
  return unwrapVolatile(parsed) as ResolvedConfig
}
