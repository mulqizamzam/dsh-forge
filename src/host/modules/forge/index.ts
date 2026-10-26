import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { forgeTools } from './tools.ts'

export const name = 'forge'
export const TOOLS = [
  'forge_discover',
  'forge_generate',
  'forge_validate',
  'forge_test',
  'forge_install',
  'forge_uninstall',
  'forge_activate',
  'forge_deactivate',
  'forge_export',
  'forge_submit',
] as const
export const readEndpoints = {}
export const writeEndpoints = {}

export function apply(deps: ModuleDeps): void {
  for (const tool of forgeTools(deps)) {
    registerToolSafe(deps.ctx, tool as never)
  }
  deps.log('forge: registered ' + TOOLS.length + ' tools')
}
