import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { stateTools } from './tools.ts'

export const name = 'state'
export const TOOLS = ['forge_list', 'forge_inspect'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

export function apply(deps: ModuleDeps): void {
  for (const tool of stateTools(deps)) {
    registerToolSafe(deps.ctx, tool as never)
  }
  deps.log('state: registered ' + TOOLS.length + ' tools')
}
