/** Minimal typed model of the host surface dsh-forge uses. */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export const JSON_OBJECT_OUTPUT = {
  type: 'object',
  properties: {},
  additionalProperties: true,
}

export interface HostSettingsScope<T> { get(): T }

export interface HostSettingsService {
  readonly writable: boolean
  /** Removed from DSH 0.1.7+; retained as an optional legacy compatibility surface. */
  register?<T>(
    namespace: string,
    schema: unknown,
    options: { base?: Partial<T>; applies: 'live' | 'restart'; validate?: (value: T) => void },
  ): HostSettingsScope<T>
}

export interface HostContextShape {
  tools: { register(def: ToolDefinition): void }
  settings: HostSettingsService
  get(name: string): unknown
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => unknown
  effect(callback: () => (() => unknown) | void, label?: string): () => unknown
  plugin?(plugin: unknown, config?: unknown): unknown
  provide?(name: string, value: unknown): () => void
  baseUrl?: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: Record<string, unknown>, value: never) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: never, execution: { signal: AbortSignal }) => Promise<unknown>
}

export function defineTool(def: ToolDefinition): ToolDefinition {
  return def
}

export function registerToolSafe(
  ctx: HostContextShape,
  definition: ToolDefinition,
): { name: string; ok: boolean; error?: string } {
  try {
    ctx.tools.register(definition)
    return { name: definition.name, ok: true }
  } catch (error) {
    return { name: definition.name, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function text(value: unknown): Array<{ type: 'text'; text: string }> {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  return [{ type: 'text', text: JSON.stringify(value) }]
}
