import type { HostContextShape } from './dsh.ts'
import type { ResolvedConfig } from './config.ts'
import type { ForgeStore } from './store.ts'

export type ForgeStatus =
  | 'generated'
  | 'validated'
  | 'tested'
  | 'installed'
  | 'active'
  | 'failed'

export interface PluginFile {
  path: string
  content: string
}

export interface DiscoveryCandidate {
  path: string
  kind: 'skill_md' | 'agent_md' | 'workflow_md' | 'command_md' | 'manifest'
  slug: string
  score: number
  recommendedTarget: 'preserve' | 'compile_skill' | 'reference_only' | 'discard'
  reasons: string[]
}

export interface ForgeRecord {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  status: ForgeStatus
  files: PluginFile[]
  validation?: {
    valid: boolean
    errors: string[]
    warnings: string[]
    checkedAt: string
    contentSha256?: string
  }
  test?: {
    passed: boolean
    exitCode: number | null
    stdout: string
    stderr: string
    durationMs: number
    checkedAt: string
    contentSha256?: string
  }
  install?: {
    installed: boolean
    profile: string
    installPath: string
    at: string
  }
  active?: {
    mounted: boolean
    toolNames: string[]
    at: string
  }
  llmUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
}

export interface ModuleDeps {
  ctx: HostContextShape
  cfg: () => ResolvedConfig
  store: ForgeStore
  log: (message: string) => void
  warn: (message: string) => void
}

export type { ToolDefinition } from './dsh.ts'
