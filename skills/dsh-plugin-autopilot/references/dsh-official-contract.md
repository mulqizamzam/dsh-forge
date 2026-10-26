# DSH Plugin Contract Baseline

Verified against the `dsh-evolution` reference implementation (mulqizamzam/dsh-evolution) and the DeepSeek Harness plugin surface. Re-check before any public profile submission.

## Manifest — `package.json`

```json
{
  "name": "your-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./package.json": "./package.json" },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "engines": { "dsh": ">=0.1.1-rc.1" }
  }
}
```

Required fields: `name`, `version`, `type`, `main`, `exports`, `files`, `dsh.bundle.patch`.

## Registry — `cordis.patch.yml`

```
- insert:
    - id: your-plugin
      name: your-plugin
      config:
        # every config field must be restated when overriding — a row
        # override replaces the row's whole `config` object
        yourPlugin: {}
```

The `insert:` array installs the plugin. The `id` must match `package.json.name`.
A kill-switch override must be a **top-level row override**, not wrapped in `update:`:

```
- id: your-plugin
  config:
    yourPlugin: {}
```

## Entry point — `apply(ctx, config)`

```
export const name = 'your-plugin'
export const inject = ['tools', 'settings']

export async function apply(rawContext, rawConfig = {}) {
  const ctx = rawContext as HostContextShape
  const cfg = resolveConfig(rawConfig)
  // register tools
  for (const tool of myTools(deps)) {
    ctx.tools.register(tool)
  }
}
```

`inject` declares host services the plugin needs. Available names typically include `'tools'`, `'settings'`, `'agents'`, `'llm'`.

## Host context verbs

| Verb ↕▾ | Purpose ↕▾ | Returns ↕▾ |
|---|---|---|
| −`ctx.tools.register(def)` | Register a tool | void |
| −`ctx.settings.register(ns, schema, { base, applies: 'live' | 'restart' })` | Register a live-writable settings scope | `{ get(): T }` |
| −`ctx.on(name, listener)` | Subscribe to a host event | disposer function |
| −`ctx.get(name)` | Optional lookup of a host service | `unknown` |
| −`ctx.effect(callback)` | Register a side effect scoped to the plugin fiber | disposer |
| −`ctx.plugin(module, config)` | Mount another plugin under this fiber | fiber with `.dispose()` |
| −`ctx.provide(name, value)` | Expose a value reachable via `ctx.get(name)` | disposer |
| −`ctx.baseUrl` | The current profile base URL (web profiles) | string | undefined |

## Tool definition

```
{
  name: 'my_tool',
  description: 'One sentence.',
  parameters: {
    type: 'object',
    properties: { q: { type: 'string', description: 'query' } },
    required: ['q'],
  },
  output: {
    schema: JSON_OBJECT_OUTPUT,     // { type: 'object', properties: {}, additionalProperties: true }
    render: (_args, value) => text(value),  // text() from dsh.ts
  },
  execute: async (args, { signal }) => {
    return neutralizeDeep({ ok: true, result: '...' })
  },
}
```

## Return-value contract (non-negotiable)

The host snapshots every tool return value with `snapshotJsonValue`. Rejects:

- any property whose value is `undefined`
- `NaN`, `Infinity`, `-Infinity`, `-0`
- cyclic references, sparse arrays, non-plain objects

A rejected return fails the entire tool call with `value is not lossless JSON`. Use `neutralizeDeep` (see `src/lib/sanitize.ts`) on every return.

## Config — `schemastery`

```
import z from 'schemastery'

export const Config = z.object({
  enabled: z.boolean().default(true),
  stateRoot: z.string().default(''),
})

export function resolveConfig(raw: unknown): ResolvedConfig {
  return Config(raw) as ResolvedConfig  // THROWS on malformed input
}
```

Do not silently fall back to defaults. If boot needs to tolerate bad config, catch the throw and register a degraded status tool.

## Settings scope

`ctx.settings.register(ns, Config, { base: rawConfig, applies: 'live' })` returns `{ get(): T }`. Reading `.get()` immediately resolves the effective config after the host applies its own overrides. Subscribe to `'settings/updated'` for live hot-swap.

## Activation — `ctx.plugin`

```
const fiber = ctx.plugin(module, config)
await fiber
// dispose:
await fiber.dispose()
```

`ctx.plugin` scopes tool/settings registrations to the fiber. Disposing the fiber unregisters everything the plugin registered. This is the load-bearing behavior for `forge_activate` and `forge_deactivate`.

## What this contract explicitly does NOT grant

- filesystem access, shell access, patch access, search access
- internet access
- implicit Python execution

Those are host-controlled. A DSH plugin must not invent manifest fields to pretend they exist.

## Version drift

The DSH host is not versioned as a stable public contract (yet). Pin the plugin against `dsh.engines.dsh >= X.Y.Z` and re-verify before every release. If the host's contract changes, the plugin must update its own contract tests — do not assume backwards compatibility.
