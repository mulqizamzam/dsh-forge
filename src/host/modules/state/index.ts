import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { stateTools } from './tools.ts'

export const name = 'state'
export const TOOLS = ['forge_list', 'forge_inspect'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

export function apply(deps: ModuleDeps): void {
  const failures: string[] = []
  let registered = 0
  for (const tool of stateTools(deps)) {
    const result = registerToolSafe(deps.ctx, tool as never)
    if (result.ok) registered++
    else failures.push(result.name + ': ' + (result.error ?? 'unknown registration error'))
  }
  if (failures.length > 0) {
    deps.warn('state: ' + failures.length + '/' + TOOLS.length + ' tool registrations failed: ' + failures.join(' | '))
    throw new Error('state tool registration incomplete (' + registered + '/' + TOOLS.length + ' registered)')
  }
  deps.log('state: registered ' + registered + ' tools')
}
