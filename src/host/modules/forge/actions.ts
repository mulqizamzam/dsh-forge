// dsh-forge — forge actions.
// Full parity with the reference discipline: discovery, generation (LLM with
// retry on empty output), fail-closed static validation, sandboxed test
// (process-group timeout), gated install, activation, export, submission.

import { join, dirname, resolve } from 'node:path'
import { mkdir, writeFile, rm, mkdtemp, access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { containPath } from '../../../lib/contain.ts'
import type { ForgeRecord, ModuleDeps, PluginFile, DiscoveryCandidate } from '../../types.ts'

// ─────────────────────────────────────────────────────────────────────────────
// LLM call — retry once on empty output (reference parity, H2 fix)
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You generate a complete DeepSeek Harness (DSH) plugin.
Output ONE JSON object and nothing else:

{
  "name": "kebab-case-plugin-name",
  "files": [
    {"path": "package.json", "content": "..."},
    {"path": "cordis.patch.yml", "content": "..."},
    {"path": "src/index.js", "content": "..."}
  ]
}

DSH plugin contract (authoritative):
- package.json MUST include: "name", "version", "type": "module", "main": "lib/index.js",
  "exports": {".": "./lib/index.js"}, "dsh": {"bundle": {"patch": "./cordis.patch.yml"}},
  "dsh.engines.dsh": ">=0.1.1-rc.1"
- cordis.patch.yml MUST contain a top-level "insert:" block with one row:
  [{ id: <name>, name: <name>, config: {} }]
- src/index.js MUST export an async apply(ctx, config) function that registers
  at least one tool via ctx.tools.register({ name, description, parameters, output, execute }).
- No TypeScript build step is permitted. Files must be plain .js ESM.

Rules:
- All content values are JSON strings; escape quotes and newlines correctly.
- Emit NO prose, NO markdown fences, NO explanation.
- Respond now with only the JSON object.`

interface LlmUsage { inputTokens: number; outputTokens: number; totalTokens: number }

async function callHostLLM(
  deps: ModuleDeps,
  system: string,
  user: string,
): Promise<{ text: string; usage: LlmUsage }> {
  const defaultModel = deps.ctx.get('agentDefaultModel') as
    { currentSelection?: () => { provider?: string; model?: string } } | undefined
  const selection = defaultModel?.currentSelection?.()
  const provider = selection?.provider
  const model = selection?.model
  if (!provider || !model) throw new Error('no configured LLM model; set agent-default-model in host settings')

  const llm = deps.ctx.get('llm') as
    { stream(opts: unknown): AsyncIterable<Record<string, unknown>> } | undefined
  if (!llm) throw new Error('LLM service not available on host context')
  const llmService = llm

  const baseMessages = [{
    id: 'forge-' + Date.now().toString(36),
    role: 'user',
    content: [{ type: 'text', text: user }],
    source: { kind: 'plugin', plugin: 'dsh-forge' },
  }]

  async function runStream(sys: string, msgs: typeof baseMessages): Promise<{ text: string; usage: LlmUsage; finishKind: string }> {
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let text = ''
    let finishKind = 'unknown'
    const stream = llmService.stream({ provider, model, system: sys, messages: msgs, maxTokens: 8192, reasoningEffort: 'low' })
    for await (const chunk of stream) {
      const type = chunk.type
      if (type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (type === 'usage') {
        const u = (chunk.usage ?? {}) as Record<string, number | undefined>
        usage.inputTokens = u.inputTokens ?? 0
        usage.outputTokens = u.outputTokens ?? 0
        usage.totalTokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
      } else if (type === 'finish') {
        const reason = (chunk.reason ?? {}) as { kind?: string; failure?: { message?: string } }
        finishKind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
        if ((reason.kind === 'error' || reason.kind === 'aborted') && typeof reason.failure?.message === 'string') {
          throw new Error('LLM call failed (' + reason.kind + '): ' + reason.failure.message)
        }
      }
    }
    return { text, usage, finishKind }
  }

  const first = await runStream(system, baseMessages)
  if (first.text.trim() !== '') return { text: first.text, usage: first.usage }

  // H2 fix — retry once with a directive; thinking routes can exhaust budget on reasoning.
  const directive = '\n\nIMPORTANT: reply with the JSON object only. No analysis, no preamble, no markdown fences.'
  const retryMessages = [{
    ...baseMessages[0],
    content: [{ type: 'text', text: user + directive }],
  }]
  const retry = await runStream(system + directive, retryMessages)
  if (retry.text.trim() === '') throw new Error('LLM returned empty content on both attempts (finish=' + retry.finishKind + ')')
  return { text: retry.text, usage: { inputTokens: first.usage.inputTokens + retry.usage.inputTokens, outputTokens: first.usage.outputTokens + retry.usage.outputTokens, totalTokens: first.usage.totalTokens + retry.usage.totalTokens } }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM output parsing (tolerant: prose, fences, path→content maps)
// ─────────────────────────────────────────────────────────────────────────────

function extractFileSet(content: string): { name: string; files: PluginFile[] } {
  const attempts: string[] = []
  const trimmed = content.trim()
  if (trimmed !== '') attempts.push(trimmed)
  for (const m of content.matchAll(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/g)) {
    if (m[1] && m[1].trim() !== '') attempts.push(m[1].trim())
  }
  const firstBrace = content.indexOf('{')
  const lastBrace = content.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) attempts.push(content.slice(firstBrace, lastBrace + 1))

  let lastErr = ''
  let sawArray = false
  let sawInvalidEntries = false
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt) as Record<string, unknown>
      const nameCandidate = typeof parsed.name === 'string'
        ? parsed.name
        : (parsed.manifest && typeof (parsed.manifest as Record<string, unknown>).name === 'string'
            ? String((parsed.manifest as Record<string, unknown>).name)
            : 'generated-plugin')
      const files: PluginFile[] = []
      const rawFiles = parsed.files
      if (Array.isArray(rawFiles)) {
        sawArray = true
        for (const f of rawFiles) {
          if (!f || typeof f !== 'object') { sawInvalidEntries = true; continue }
          const obj = f as Record<string, unknown>
          if (typeof obj.path === 'string' && typeof obj.content === 'string') {
            files.push({ path: obj.path, content: obj.content })
          } else {
            sawInvalidEntries = true
          }
        }
      } else if (rawFiles && typeof rawFiles === 'object') {
        for (const [k, v] of Object.entries(rawFiles as Record<string, unknown>)) {
          if (typeof v === 'string') files.push({ path: k, content: v })
        }
      }
      if (files.length === 0) { lastErr = 'no files array'; continue }
      return { name: nameCandidate, files }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  // H3 fix — surface the real cause when files array exists but every entry was invalid.
  if (sawArray && sawInvalidEntries) {
    throw new Error('LLM output had a files array but every entry lacked string "path" and "content"')
  }
  throw new Error(
    'LLM output did not contain a valid {name, files:[{path,content}]} JSON object'
    + (lastErr ? ' (' + lastErr + ')' : ''),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Static validation — DSH contract, fail-closed
// ─────────────────────────────────────────────────────────────────────────────

const APPLY_EXPORT_RE = /\bexport\s+(async\s+)?(function\s+apply\b|const\s+apply\b|let\s+apply\b|var\s+apply\b|\{[^}]*\bapply\b[^}]*\})/
const MAX_FILE_BYTES = 1 * 1024 * 1024 // M2 fix — size cap per file

export function validatePlugin(files: PluginFile[]): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  for (const f of files) {
    if (containPath('/plugin-root', f.path) === null) {
      errors.push('unsafe file path: ' + f.path)
    }
    if (f.content.length > MAX_FILE_BYTES) {
      errors.push('file exceeds 1 MiB size cap: ' + f.path)
    }
  }
  if (errors.length > 0) return { valid: false, errors, warnings }

  const pkg = files.find(f => f.path === 'package.json')
  if (!pkg) errors.push('missing package.json')
  else {
    try {
      const p = JSON.parse(pkg.content) as Record<string, unknown>
      if (typeof p.name !== 'string' || p.name === '') errors.push('package.json: "name" is required')
      if (typeof p.version !== 'string' || !/^\d+\.\d+\.\d+/.test(p.version)) errors.push('package.json: "version" must be semver')
      const dsh = p.dsh as Record<string, unknown> | undefined
      if (!dsh || typeof dsh !== 'object') errors.push('package.json: "dsh" object is required')
      else {
        const bundle = dsh.bundle as Record<string, unknown> | undefined
        if (!bundle || bundle.patch !== './cordis.patch.yml') errors.push('package.json: dsh.bundle.patch must be "./cordis.patch.yml"')
      }
    } catch { errors.push('package.json is not valid JSON') }
  }

  const patch = files.find(f => f.path === 'cordis.patch.yml')
  if (!patch) errors.push('missing cordis.patch.yml')
  else if (!patch.content.includes('insert:')) errors.push('cordis.patch.yml must contain an "insert:" block')

  const entry = files.find(f => f.path === 'src/index.js')
  if (!entry) errors.push('missing entry file: src/index.js is required')
  else if (!APPLY_EXPORT_RE.test(entry.content)) {
    errors.push('src/index.js must export an "apply" symbol (export function apply / export const apply / export { apply })')
  } else if (!entry.content.includes('ctx.tools.register') && !entry.content.includes('.tools.register')) {
    warnings.push('src/index.js exports apply but does not visibly call ctx.tools.register — the plugin may register no tools')
  }

  return { valid: errors.length === 0, errors, warnings }
}

// ─────────────────────────────────────────────────────────────────────────────
// Repo discovery (parity with reference analyze_repo.py)
// ─────────────────────────────────────────────────────────────────────────────

export async function discoverRepo(repoRoot: string): Promise<{
  ok: true
  candidates: DiscoveryCandidate[]
  summary: { fileCount: number; candidateCount: number }
} | { ok: false; error: string }> {
  const root = resolve(repoRoot)
  try { await access(root) } catch { return { ok: false, error: 'repo root not found: ' + root } }

  const candidates: DiscoveryCandidate[] = []
  const { readdir, stat } = await import('node:fs/promises')

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return
    let names: string[]
    try { names = await readdir(dir) } catch { return }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'lib') continue
      const full = join(dir, name)
      let s: Awaited<ReturnType<typeof stat>>
      try { s = await stat(full) } catch { continue }
      if (s.isDirectory()) { await walk(full, depth + 1); continue }
      if (!s.isFile()) continue
      if (!/\.(md|markdown|yaml|yml|json)$/.test(name)) continue
      const rel = full.slice(root.length + 1).split(/[\\/]/).join('/')
      if (name === 'SKILL.md') {
        candidates.push({ path: rel, kind: 'skill_md', slug: slugFromPath(rel), score: 100, recommendedTarget: 'preserve', reasons: ['existing Agent Skill'] })
      } else if (name === 'AGENTS.md' || name === 'CLAUDE.md' || name === 'GEMINI.md') {
        candidates.push({ path: rel, kind: 'agent_md', slug: slugFromPath(rel) + '-workflow', score: 85, recommendedTarget: 'compile_skill', reasons: ['agent instructions'] })
      } else if (/\/(playbooks?|workflows?|commands?|prompts?|recipes?)\//.test(rel)) {
        candidates.push({ path: rel, kind: 'workflow_md', slug: slugFromPath(rel), score: 75, recommendedTarget: 'compile_skill', reasons: ['workflow document'] })
      } else if (/(workflow|playbook|runbook|checklist)\.(md|markdown)$/i.test(name)) {
        candidates.push({ path: rel, kind: 'workflow_md', slug: slugFromPath(rel), score: 65, recommendedTarget: 'compile_skill', reasons: ['filename indicates repeatable procedure'] })
      }
    }
  }

  await walk(root, 0)
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))

  return { ok: true, candidates, summary: { fileCount: candidates.length, candidateCount: candidates.length } }
}

function slugFromPath(rel: string): string {
  return rel.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'workflow'
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox (bwrap) — fail-closed, process-group timeout (H1 fix)
// ─────────────────────────────────────────────────────────────────────────────

function exists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false)
}

async function bwrapAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    const c = spawn('bwrap', ['--version'], { stdio: 'ignore', detached: true })
    c.on('close', code => resolve(code === 0))
    c.on('error', () => resolve(false))
    setTimeout(() => { try { if (c.pid) process.kill(-c.pid, 'SIGKILL'); else c.kill() } catch { /* ignore */ } resolve(false) }, 3000)
  })
}

interface SpawnResult { exitCode: number | null; stdout: string; stderr: string; durationMs: number }

// H1 fix — detached process group + SIGKILL on group, not just direct child.
function spawnProcess(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; env?: Record<string, string> },
): Promise<SpawnResult> {
  return new Promise(resolve => {
    const start = Date.now()
    let stdout = ''
    let stderr = ''
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    child.stdout?.on('data', d => { stdout += d.toString() })
    child.stderr?.on('data', d => { stderr += d.toString() })
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }
    }, opts.timeoutMs)
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - start }) })
    child.on('error', e => {
      clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr: stderr + '\nspawn error: ' + e.message, durationMs: Date.now() - start })
    })
  })
}

export async function testInSandbox(
  _deps: ModuleDeps,
  files: PluginFile[],
  timeoutMs: number,
): Promise<ForgeRecord['test']> {
  const checkedAt = new Date().toISOString()
  if (!(await bwrapAvailable())) {
    return { passed: false, exitCode: null, stdout: '', stderr: 'bwrap not available — cannot run sandbox test', durationMs: 0, checkedAt }
  }
  for (const f of files) {
    if (containPath('/forge-test', f.path) === null) {
      return { passed: false, exitCode: null, stdout: '', stderr: 'unsafe path: ' + f.path, durationMs: 0, checkedAt }
    }
  }
  const workDir = await mkdtemp(join(tmpdir(), 'forge-test-'))
  try {
    for (const f of files) {
      const target = containPath(workDir, f.path)
      if (target === null) return { passed: false, exitCode: null, stdout: '', stderr: 'unsafe path: ' + f.path, durationMs: 0, checkedAt }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, f.content, 'utf8')
    }
    const entry = files.find(f => f.path === 'src/index.js')?.path
    if (!entry) return { passed: false, exitCode: null, stdout: '', stderr: 'no src/index.js', durationMs: 0, checkedAt }

    const harnessPath = join(workDir, '.forge-test.mjs')
    await writeFile(harnessPath, `
import { pathToFileURL } from 'node:url'
const entryUrl = pathToFileURL(${JSON.stringify(entry)}).href
const mod = await import(entryUrl)
if (typeof mod.apply !== 'function') { console.error('NO_APPLY_EXPORT'); process.exit(3) }
const registered = []
const fakeCtx = {
  tools: { register: (d) => { if (d && typeof d.name === 'string') registered.push(d.name) } },
  settings: { writable: true, register: () => ({ get: () => ({}) }) },
  get: () => undefined,
  on: () => () => {},
  effect: () => () => {},
}
try { await mod.apply(fakeCtx, {}) }
catch (e) { console.error('APPLY_THREW: ' + (e && e.message ? e.message : String(e))); process.exit(4) }
if (registered.length === 0) { console.error('NO_TOOLS_REGISTERED'); process.exit(5) }
console.log('OK_TOOLS:' + registered.join(','))
`, 'utf8')

    const bwrapArgs: string[] = ['--clearenv']
    for (const p of ['/usr', '/lib', '/lib64', '/bin', '/sbin']) {
      if (await exists(p)) bwrapArgs.push('--ro-bind', p, p)
    }
    const nodeBinDir = dirname(process.execPath)
    if (await exists(nodeBinDir)) bwrapArgs.push('--ro-bind', nodeBinDir, nodeBinDir)
    bwrapArgs.push(
      '--bind', workDir, workDir,
      '--chdir', workDir,
      '--unshare-pid',
      '--unshare-net',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--setenv', 'PATH', nodeBinDir + ':/usr/local/bin:/usr/bin:/bin',
      '/bin/sh', '-c', 'node .forge-test.mjs',
    )

    const r = await spawnProcess('bwrap', bwrapArgs, { timeoutMs })
    return {
      passed: r.exitCode === 0 && r.stdout.includes('OK_TOOLS:'),
      exitCode: r.exitCode,
      stdout: r.stdout.slice(0, 10_000),
      stderr: r.stderr.slice(0, 10_000),
      durationMs: r.durationMs,
      checkedAt,
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate
// ─────────────────────────────────────────────────────────────────────────────

export async function generatePlugin(
  deps: ModuleDeps,
  description: string,
): Promise<{ record: ForgeRecord } | { error: string }> {
  try {
    const { text, usage } = await callHostLLM(deps, SYSTEM_PROMPT, description)
    const { name, files } = extractFileSet(text)
    const record = await deps.store.add({ name, description, files, llmUsage: usage })
    return { record }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Install — GATED on validate + test
// ─────────────────────────────────────────────────────────────────────────────

export async function installPlugin(
  deps: ModuleDeps,
  id: string,
  profile?: string,
): Promise<{ ok: true; installPath: string; profile: string } | { ok: false; error: string }> {
  const record = await deps.store.get(id)
  if (!record) return { ok: false, error: 'record not found: ' + id }
  const cfg = deps.cfg().forge
  if (cfg.install.requireValidated && !record.validation?.valid) {
    return { ok: false, error: 'refusing to install: static validation must pass first (run forge_validate)' }
  }
  if (cfg.install.requireTested && !record.test?.passed) {
    return { ok: false, error: 'refusing to install: sandbox test must pass first (run forge_test)' }
  }
  const chosenProfile = profile || cfg.defaultProfile
  const installPath = join(deps.store.getRoot(), 'installed', id)
  await rm(installPath, { recursive: true, force: true }).catch(() => { /* ignore */ })
  for (const f of record.files) {
    const target = containPath(installPath, f.path)
    if (target === null) return { ok: false, error: 'unsafe file path: ' + f.path }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, f.content, 'utf8')
  }
  const r = await spawnProcess('dsh', ['plugin', '--profile', chosenProfile, 'add', installPath], { timeoutMs: 60_000 })
  if (r.exitCode !== 0) {
    return { ok: false, error: 'dsh plugin add failed (exit ' + String(r.exitCode) + '): ' + r.stderr.slice(0, 500) }
  }
  await deps.store.update(id, {
    status: 'installed',
    install: { installed: true, profile: chosenProfile, installPath, at: new Date().toISOString() },
  })
  return { ok: true, installPath, profile: chosenProfile }
}

// ─────────────────────────────────────────────────────────────────────────────
// Uninstall
// ─────────────────────────────────────────────────────────────────────────────

export async function uninstallPlugin(
  deps: ModuleDeps,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const record = await deps.store.get(id)
  if (!record) return { ok: false, error: 'record not found: ' + id }
  if (!record.install?.installed) return { ok: false, error: 'plugin is not installed' }
  const profile = record.install.profile
  let pkgName = record.name
  const pkg = record.files.find(f => f.path === 'package.json')
  if (pkg) {
    try {
      const p = JSON.parse(pkg.content) as Record<string, unknown>
      if (typeof p.name === 'string' && p.name !== '') pkgName = p.name
    } catch { /* keep record.name */ }
  }
  const r = await spawnProcess('dsh', ['plugin', '--profile', profile, 'remove', pkgName], { timeoutMs: 60_000 })
  if (r.exitCode !== 0) {
    return { ok: false, error: 'dsh plugin remove failed (exit ' + String(r.exitCode) + '): ' + r.stderr.slice(0, 500) }
  }
  // L2 fix — restore previous status (tested), not 'installed'.
  await deps.store.update(id, { status: 'tested', install: undefined })
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Activate / Deactivate — C1 fix: restore register in finally
// ─────────────────────────────────────────────────────────────────────────────

const activeFibers = new Map<string, { dispose?: () => unknown }>()

export async function activatePlugin(
  deps: ModuleDeps,
  id: string,
): Promise<{ ok: true; toolNames: string[] } | { ok: false; error: string }> {
  const record = await deps.store.get(id)
  if (!record) return { ok: false, error: 'record not found: ' + id }
  if (!record.validation?.valid) return { ok: false, error: 'cannot activate: static validation must pass first' }
  if (!record.test?.passed) return { ok: false, error: 'cannot activate: sandbox test must pass first' }

  const installPath = record.install?.installPath ?? join(deps.store.getRoot(), 'installed', id)
  const entryFile = record.files.find(f => f.path === 'src/index.js')
  if (!entryFile) return { ok: false, error: 'record has no src/index.js' }
  const entryPath = join(installPath, entryFile.path)
  if (!(await exists(entryPath))) {
    for (const f of record.files) {
      const target = containPath(installPath, f.path)
      if (target === null) return { ok: false, error: 'unsafe file path: ' + f.path }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, f.content, 'utf8')
    }
  }

  const ctx = deps.ctx
  if (typeof ctx.plugin !== 'function') {
    return { ok: false, error: 'host context does not expose ctx.plugin — dynamic mount unavailable' }
  }

  let mod: { apply?: unknown }
  try {
    mod = await import(pathToFileURL(entryPath).href) as { apply?: unknown }
  } catch (e) {
    return { ok: false, error: 'dynamic import failed: ' + (e instanceof Error ? e.message : String(e)) }
  }
  if (typeof mod.apply !== 'function') return { ok: false, error: 'module does not export an apply function' }

  const registered: string[] = []
  const originalRegister = ctx.tools.register.bind(ctx.tools)
  const patchedRegister = (def: { name?: unknown }) => {
    if (def && typeof def.name === 'string') registered.push(def.name)
    originalRegister(def as never)
  }
  ;(ctx.tools as { register: typeof patchedRegister }).register = patchedRegister

  let fiber: { dispose?: () => unknown } | undefined
  try {
    fiber = ctx.plugin(mod, {}) as { dispose?: () => unknown }
    await (fiber as unknown as Promise<unknown>)
  } catch (e) {
    return { ok: false, error: 'mount failed: ' + (e instanceof Error ? e.message : String(e)) }
  } finally {
    // C1 fix — always restore, including success path, to avoid closure leak.
    ;(ctx.tools as { register: typeof originalRegister }).register = originalRegister
  }
  if (!fiber) return { ok: false, error: 'mount produced no fiber' }

  activeFibers.set(id, fiber)
  await deps.store.update(id, {
    status: 'active',
    active: { mounted: true, toolNames: registered.slice(), at: new Date().toISOString() },
  })
  return { ok: true, toolNames: registered }
}

export async function deactivatePlugin(
  deps: ModuleDeps,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fiber = activeFibers.get(id)
  if (!fiber) return { ok: false, error: 'plugin is not active in this host' }
  try { if (typeof fiber.dispose === 'function') await fiber.dispose() } catch { /* ignore */ }
  activeFibers.delete(id)
  await deps.store.update(id, { status: 'installed', active: undefined })
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export — package as .tgz
// ─────────────────────────────────────────────────────────────────────────────

export async function exportPlugin(
  deps: ModuleDeps,
  id: string,
  outPath?: string,
): Promise<{ ok: true; outPath: string } | { ok: false; error: string }> {
  const record = await deps.store.get(id)
  if (!record) return { ok: false, error: 'record not found: ' + id }
  const srcPath = record.install?.installPath ?? join(deps.store.getRoot(), 'installed', id)
  if (!(await exists(srcPath))) {
    for (const f of record.files) {
      const target = containPath(srcPath, f.path)
      if (target === null) return { ok: false, error: 'unsafe file path: ' + f.path }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, f.content, 'utf8')
    }
  }
  const out = outPath ?? join(deps.store.getRoot(), 'exports', `${record.name}-${id}.tgz`)
  await mkdir(dirname(out), { recursive: true })
  const r = await spawnProcess('tar', ['-czf', out, '-C', srcPath, '.'], { timeoutMs: 30_000 })
  if (r.exitCode !== 0) return { ok: false, error: 'tar failed: ' + r.stderr.slice(0, 500) }
  return { ok: true, outPath: out }
}

// ─────────────────────────────────────────────────────────────────────────────
// Submission packet (parity with reference submission/listing.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface SubmissionListing {
  name: string
  subtitle: string
  description: string
  category: string
  developerName: string
  version: string
  packageName: string
  capabilities: string[]
  starterPrompts: string[]
  hostCapabilities: { workspace: string[]; note: string }
  sourceRef?: string
  artifactSha256?: string
}

export function buildSubmissionListing(record: ForgeRecord, cfg: {
  developerName?: string
  starterPrompts?: string[]
  category?: string
}): SubmissionListing {
  let pkgName = record.name
  let version = '0.1.0'
  const pkg = record.files.find(f => f.path === 'package.json')
  if (pkg) {
    try {
      const p = JSON.parse(pkg.content) as Record<string, unknown>
      if (typeof p.name === 'string' && p.name !== '') pkgName = p.name
      if (typeof p.version === 'string' && p.version !== '') version = p.version
    } catch { /* keep defaults */ }
  }
  return {
    name: record.name,
    subtitle: (record.description || 'DSH plugin').slice(0, 30),
    description: record.description || 'DSH plugin generated by dsh-forge.',
    category: cfg.category ?? 'Developer Tools',
    developerName: cfg.developerName ?? 'dsl-forge contributor',
    version,
    packageName: pkgName,
    capabilities: record.files
      .filter(f => f.path === 'src/index.js')
      .flatMap(f => {
        const names = Array.from(f.content.matchAll(/name:\s*['"`]([^'"`]+)['"`]/g))
        return names.map(m => m[1]).slice(0, 20)
      }),
    starterPrompts: cfg.starterPrompts ?? ['Use this plugin to complete its documented workflow.'],
    hostCapabilities: {
      workspace: ['read', 'list', 'search', 'grep', 'write', 'patch', 'shell', 'python'],
      note: 'Host-native capabilities are used when available; the plugin does not grant these permissions.',
    },
    sourceRef: record.id,
  }
}
