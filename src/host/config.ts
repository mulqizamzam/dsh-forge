import z from 'schemastery'

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

export const Config = z.object({
  stateRoot: z.string().default(DEFAULT_CONFIG.stateRoot),
  forge: z.object({
    defaultProfile: z.string().default(DEFAULT_CONFIG.forge.defaultProfile),
    sandbox: z.object({
      enabled: z.boolean().default(DEFAULT_CONFIG.forge.sandbox.enabled),
      timeoutMs: z.number().default(DEFAULT_CONFIG.forge.sandbox.timeoutMs),
    }).default(DEFAULT_CONFIG.forge.sandbox),
    install: z.object({
      requireValidated: z.boolean().default(DEFAULT_CONFIG.forge.install.requireValidated),
      requireTested: z.boolean().default(DEFAULT_CONFIG.forge.install.requireTested),
    }).default(DEFAULT_CONFIG.forge.install),
    activation: z.object({
      allowInProcessExecution: z.boolean().default(DEFAULT_CONFIG.forge.activation.allowInProcessExecution),
    }).default(DEFAULT_CONFIG.forge.activation),
  }).default(DEFAULT_CONFIG.forge),
})

export type ResolvedConfig = ForgeConfig

export function resolveConfig(raw: unknown): ResolvedConfig {
  return Config(raw as Parameters<typeof Config>[0]) as ResolvedConfig
}
