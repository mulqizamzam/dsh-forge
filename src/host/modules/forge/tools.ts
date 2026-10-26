import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import type { ModuleDeps, ToolDefinition } from '../../types.ts'
import {
  activatePlugin,
  buildSubmissionListing,
  deactivatePlugin,
  discoverRepo,
  exportPlugin,
  generatePlugin,
  installPlugin,
  testInSandbox,
  uninstallPlugin,
  validatePlugin,
} from './actions.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

export function forgeTools(deps: ModuleDeps): ToolDefinition[] {
  return [
    defineTool({
      name: 'forge_discover',
      description: 'Scan an agentic repository for DSH-plugin-worthy workflow candidates. Read-only. Returns candidates with dispositions: preserve_skill, compile_skill, reference_only, discard.',
      parameters: {
        type: 'object',
        properties: {
          repoRoot: { type: 'string', description: 'Absolute path to the repository root to scan.' },
        },
        required: ['repoRoot'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const repoRoot = typeof a.repoRoot === 'string' ? a.repoRoot : ''
        if (!repoRoot) return neutralizeDeep({ ok: false, error: 'repoRoot is required' })
        const r = await discoverRepo(repoRoot)
        return neutralizeDeep(r)
      },
    } as never),

    defineTool({
      name: 'forge_generate',
      description: 'Generate a complete DSH plugin from a text description using the configured LLM. The DSH contract is injected into the prompt (package.json with dsh.bundle.patch, cordis.patch.yml with insert:, src/index.js exporting apply). One retry is performed if the LLM returns empty content on the first attempt.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Natural-language description of the DSH plugin to generate.' },
        },
        required: ['description'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const description = typeof a.description === 'string' ? a.description : ''
        if (!description.trim()) return neutralizeDeep({ ok: false, error: 'description is required' })
        const result = await generatePlugin(deps, description)
        if ('error' in result) return neutralizeDeep({ ok: false, error: result.error })
        return neutralizeDeep({ ok: true, record: result.record })
      },
    } as never),

    defineTool({
      name: 'forge_validate',
      description: 'Statically validate a stored DSH plugin record. Checks: package.json (semver, dsh.bundle.patch), cordis.patch.yml (insert: block), src/index.js (apply export), no path traversal, file size cap. Persists the outcome and updates the record status.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Record ID returned by forge_generate.' } },
        required: ['id'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const id = typeof a.id === 'string' ? a.id : ''
        const record = await deps.store.get(id)
        if (!record) return neutralizeDeep({ ok: false, error: 'record not found: ' + id })
        const result = validatePlugin(record.files)
        await deps.store.update(id, {
          status: result.valid ? 'validated' : 'failed',
          validation: { ...result, checkedAt: new Date().toISOString() },
        })
        return neutralizeDeep({ ok: true, ...result, recordId: id })
      },
    } as never),

    defineTool({
      name: 'forge_test',
      description: 'Run a validated DSH plugin inside a bwrap sandbox: import the entry, call apply() with a fake host context, require at least one tool registered. Requires static validation to have passed first. Fail-closed when bwrap is unavailable. Timeout kills the whole process group.',
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
        if (!record) return neutralizeDeep({ ok: false, error: 'record not found: ' + id })
        if (!record.validation?.valid) return neutralizeDeep({ ok: false, error: 'static validation must pass before testing (run forge_validate)' })
        const cfg = deps.cfg().forge
        if (!cfg.sandbox.enabled) return neutralizeDeep({ ok: false, error: 'sandbox is disabled in config (forge.sandbox.enabled=false)' })
        const result = await testInSandbox(deps, record.files, cfg.sandbox.timeoutMs)
        await deps.store.update(id, { status: result?.passed ? 'tested' : 'failed', test: result ?? undefined })
        return neutralizeDeep({ ok: true, test: result, recordId: id })
      },
    } as never),

    defineTool({
      name: 'forge_install',
      description: 'Install a stored plugin into a DSH profile via `dsh plugin add <path>`. Refuses unless static validation AND sandbox test have passed. Runs dsh un-sandboxed because it must mutate the real profile.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Record ID.' },
          profile: { type: 'string', description: 'DSH profile name. Defaults to config forge.defaultProfile.' },
        },
        required: ['id'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const id = typeof a.id === 'string' ? a.id : ''
        const profile = typeof a.profile === 'string' ? a.profile : undefined
        const result = await installPlugin(deps, id, profile)
        return neutralizeDeep(result)
      },
    } as never),

    defineTool({
      name: 'forge_uninstall',
      description: 'Uninstall a previously-installed plugin via `dsh plugin remove <pkg-name>` in its recorded profile.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Record ID.' } },
        required: ['id'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const id = typeof a.id === 'string' ? a.id : ''
        return neutralizeDeep(await uninstallPlugin(deps, id))
      },
    } as never),

    defineTool({
      name: 'forge_activate',
      description: 'Mount a validated + tested plugin into the currently-running host via ctx.plugin. Requires forge_validate and forge_test to have passed. Unmount with forge_deactivate.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Record ID.' } },
        required: ['id'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const id = typeof a.id === 'string' ? a.id : ''
        return neutralizeDeep(await activatePlugin(deps, id))
      },
    } as never),

    defineTool({
      name: 'forge_deactivate',
      description: 'Unmount a currently-active plugin from the running host by disposing its mounted fiber.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Record ID.' } },
        required: ['id'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const id = typeof a.id === 'string' ? a.id : ''
        return neutralizeDeep(await deactivatePlugin(deps, id))
      },
    } as never),

    defineTool({
      name: 'forge_export',
      description: 'Package a stored plugin as a .tgz archive via `tar -czf`. Default output path is <stateRoot>/exports/<name>-<id>.tgz.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Record ID.' },
          outPath: { type: 'string', description: 'Optional absolute output path for the .tgz archive.' },
        },
        required: ['id'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const id = typeof a.id === 'string' ? a.id : ''
        const outPath = typeof a.outPath === 'string' ? a.outPath : undefined
        return neutralizeDeep(await exportPlugin(deps, id, outPath))
      },
    } as never),

    defineTool({
      name: 'forge_submit',
      description: 'Build a submission packet (listing metadata) for a validated + tested plugin record. The packet is repo-maintained evidence for DSH profile submission — it does not imply marketplace approval.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Record ID.' },
          developerName: { type: 'string', description: 'Optional verified developer name for the listing.' },
          category: { type: 'string', description: 'Optional category (defaults to Developer Tools).' },
        },
        required: ['id'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const id = typeof a.id === 'string' ? a.id : ''
        const record = await deps.store.get(id)
        if (!record) return neutralizeDeep({ ok: false, error: 'record not found: ' + id })
        if (!record.validation?.valid) return neutralizeDeep({ ok: false, error: 'record must pass forge_validate before submission packet is built' })
        const listing = buildSubmissionListing(record, {
          developerName: typeof a.developerName === 'string' ? a.developerName : undefined,
          category: typeof a.category === 'string' ? a.category : undefined,
        })
        return neutralizeDeep({ ok: true, listing, note: 'This is repo-maintained evidence, not proof of DSH profile approval.' })
      },
    } as never),
  ]
}
