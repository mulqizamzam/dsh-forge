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
  'forge_reconcile',
  'forge_activate',
  'forge_deactivate',
  'forge_export',
  'forge_submit',
] as const
export const readEndpoints = {}
export const writeEndpoints = {}

export function apply(deps: ModuleDeps): void {
  const tools = forgeTools(deps)
  const failures: string[] = []
  let registered = 0
  for (const tool of tools) {
    const result = registerToolSafe(deps.ctx, tool as never)
    if (result.ok) registered++
    else failures.push(result.name + ': ' + (result.error ?? 'unknown registration error'))
  }
  if (failures.length > 0) {
    deps.warn('forge: ' + failures.length + '/' + tools.length + ' tool registrations failed: ' + failures.join(' | '))
    throw new Error('forge tool registration incomplete (' + registered + '/' + TOOLS.length + ' registered)')
  }
  deps.log('forge: registered ' + registered + ' tools')
}
