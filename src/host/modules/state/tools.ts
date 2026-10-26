import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import type { ModuleDeps, ToolDefinition } from '../../types.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

export function stateTools(deps: ModuleDeps): ToolDefinition[] {
  return [
    defineTool({
      name: 'forge_list',
      description: 'List stored forge records (generated plugins), newest first.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max records to return. Defaults to 50.' } },
        required: [],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const limit = typeof a.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(a.limit))) : 50
        const records = await deps.store.list(limit)
        return neutralizeDeep({
          count: records.length,
          records: records.map(r => ({
            id: r.id, name: r.name, status: r.status,
            createdAt: r.createdAt, updatedAt: r.updatedAt,
            validated: r.validation?.valid === true,
            tested: r.test?.passed === true,
            installed: r.install?.installed === true,
            active: r.active?.mounted === true,
          })),
        })
      },
    } as never),

    defineTool({
      name: 'forge_inspect',
      description: 'Get the full stored record for one forge entry.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Record ID.' } },
        required: ['id'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const id = typeof a.id === 'string' ? a.id : ''
        const record = await deps.store.get(id)
        return neutralizeDeep({ found: record !== null, record })
      },
    } as never),
  ]
}
