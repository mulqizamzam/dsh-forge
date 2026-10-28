// dsh-forge — forge actions.
// Full parity with the reference discipline: discovery, generation (LLM with
// retry on empty output), fail-closed static validation, sandboxed test
// (process-group timeout), gated install, activation, export, submission.

import { join, dirname, resolve, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
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
    {"path": "src/index.js", "content": "..."},
    {"path": "lib/index.js", "content": "..."}
  ]
}

DSH plugin contract (authoritative):
- package.json MUST include: "name", "version", "type": "module", "main": "lib/index.js",
  "exports": {".": "./lib/index.js"}, "dsh": {"bundle": {"patch": "./cordis.patch.yml"}},
  "dsh.engines.dsh": ">=0.1.1-rc.1"
- cordis.patch.yml MUST contain a top-level "insert:" block with one row:
  [{ id: <name>, name: <name>, config: {} }]
- src/index.js and lib/index.js MUST both export an async apply(ctx, config) function
  that registers at least one tool via ctx.tools.register({ name, description, parameters, output, execute }).
- lib/index.js is the runtime entry and MUST contain the same executable ESM implementation as src/index.js.
- package.json main MUST be "lib/index.js" and exports["."] MUST be "./lib/index.js".
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
      if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(nameCandidate)) {
        throw new Error('plugin name must be a lowercase package slug (1–100 chars)')
      }
      if (files.length > MAX_PLUGIN_FILES) throw new Error('plugin contains more than ' + MAX_PLUGIN_FILES + ' files')
      const seenPaths = new Set<string>()
      let totalBytes = 0
      for (const file of files) {
        if (containPath('/plugin-root', file.path) === null) throw new Error('unsafe file path: ' + file.path)
        const portablePath = file.path.toLowerCase()
        if (seenPaths.has(portablePath)) throw new Error('duplicate file path: ' + file.path)
        seenPaths.add(portablePath)
        const bytes = Buffer.byteLength(file.content, 'utf8')
        if (bytes > MAX_FILE_BYTES) throw new Error('file exceeds 1 MiB size cap: ' + file.path)
        totalBytes += bytes
        if (totalBytes > MAX_PLUGIN_BYTES) throw new Error('plugin exceeds 5 MiB total content limit')
      }
      const packageFile = files.find(file => file.path === 'package.json')
      if (!packageFile) throw new Error('generated plugin is missing package.json')
      let declaredName: unknown
      try { declaredName = (JSON.parse(packageFile.content) as Record<string, unknown>).name }
      catch { throw new Error('generated package.json is not valid JSON') }
      if (declaredName !== nameCandidate) throw new Error('generated name must match package.json name')
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
const MAX_FILE_BYTES = 1 * 1024 * 1024 // per-file content cap
const MAX_PLUGIN_BYTES = 5 * 1024 * 1024 // aggregate model output / storage cap
const MAX_PLUGIN_FILES = 200
const MAX_CAPTURE_CHARS = 64 * 1024
const MAX_DESCRIPTION_CHARS = 12_000
const FORBIDDEN_SEGMENT_RE = /^(?:\.git|node_modules|\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)(?:\..*)?|authorized_keys|known_hosts)$/i

/** Canonical digest used to tie validation and test results to exact stored bytes. */
export function pluginContentDigest(files: unknown): string | null {
  if (!Array.isArray(files)) return null
  const normalized: Array<[string, string]> = []
  for (const entry of files) {
    if (!entry || typeof entry !== 'object') return null
    const item = entry as Record<string, unknown>
    if (typeof item.path !== 'string' || typeof item.content !== 'string') return null
    normalized.push([item.path, item.content])
  }
  normalized.sort((a, b) => a[0].localeCompare(b[0]))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

/** Remove comments and string/template literals before conservative source checks. */
function stripJavaScriptCommentsAndLiterals(source: string): string {
  const out = source.split('')
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  let escaped = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    const next = source[i + 1] ?? ''
    if (state === 'code') {
      if (ch === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i++; state = 'line'; continue }
      if (ch === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; i++; state = 'block'; continue }
      if (ch === "'") { out[i] = ' '; state = 'single'; escaped = false; continue }
      if (ch === '"') { out[i] = ' '; state = 'double'; escaped = false; continue }
      if (ch.charCodeAt(0) === 96) { out[i] = ' '; state = 'template'; escaped = false; continue }
    } else if (state === 'line') {
      if (ch === '\n' || ch === '\r') state = 'code'
      else out[i] = ' '
    } else if (state === 'block') {
      if (ch === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i++; state = 'code'; continue }
      if (ch !== '\n' && ch !== '\r') out[i] = ' '
    } else {
      if (ch !== '\n' && ch !== '\r') out[i] = ' '
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch.charCodeAt(0) === 96)) state = 'code'
    }
  }
  return out.join('')
}

export function validatePlugin(filesInput: unknown): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!Array.isArray(filesInput)) return { valid: false, errors: ['plugin files must be an array'], warnings }
  if (filesInput.length === 0) return { valid: false, errors: ['plugin file list is empty'], warnings }
  if (filesInput.length > MAX_PLUGIN_FILES) errors.push('plugin exceeds ' + MAX_PLUGIN_FILES + ' file limit')

  const files: PluginFile[] = []
  for (const raw of filesInput) {
    if (!raw || typeof raw !== 'object') { errors.push('each plugin file must be an object'); continue }
    const item = raw as Record<string, unknown>
    if (typeof item.path !== 'string' || typeof item.content !== 'string') {
      errors.push('each plugin file must contain string path and content fields')
      continue
    }
    files.push({ path: item.path, content: item.content })
  }
  if (errors.length > 0) return { valid: false, errors, warnings }

  const seenPaths = new Set<string>()
  let totalBytes = 0
  const normalizedPaths = files.map(f => f.path.toLowerCase())
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!
    if (containPath('/plugin-root', f.path) === null) {
      errors.push('unsafe file path: ' + f.path)
      continue
    }
    const portablePath = f.path.toLowerCase()
    if (seenPaths.has(portablePath)) errors.push('duplicate file path: ' + f.path)
    seenPaths.add(portablePath)
    if (f.path.split('/').some(segment => FORBIDDEN_SEGMENT_RE.test(segment))) {
      errors.push('sensitive or vendor path is not allowed: ' + f.path)
    }
    const bytes = Buffer.byteLength(f.content, 'utf8')
    totalBytes += bytes
    if (bytes > MAX_FILE_BYTES) errors.push('file exceeds 1 MiB size cap: ' + f.path)
    for (let j = 0; j < normalizedPaths.length; j++) {
      if (i !== j && normalizedPaths[j]!.startsWith(portablePath + '/')) {
        errors.push('file path conflicts with a directory path: ' + f.path)
        break
      }
    }
  }
  if (totalBytes > MAX_PLUGIN_BYTES) errors.push('plugin exceeds 5 MiB total content limit')
  if (errors.length > 0) return { valid: false, errors, warnings }

  const pkg = files.find(f => f.path === 'package.json')
  let packageName: string | undefined
  if (!pkg) errors.push('missing package.json')
  else {
    try {
      const p = JSON.parse(pkg.content) as Record<string, unknown>
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('package.json root must be an object')
      if (typeof p.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(p.name)) {
        errors.push('package.json: "name" must be a lowercase package slug (1–100 chars)')
      } else packageName = p.name
      if (p.type !== 'module') errors.push('package.json: "type" must be "module" for ESM plugin entries')
      if (typeof p.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(p.version)) {
        errors.push('package.json: "version" must be valid semver')
      }
      if (p.main !== 'lib/index.js') errors.push('package.json: "main" must be "lib/index.js"')
      const exports = p.exports as Record<string, unknown> | undefined
      if (!exports || typeof exports !== 'object' || Array.isArray(exports) || exports['.'] !== './lib/index.js') {
        errors.push('package.json: exports["."] must be "./lib/index.js"')
      }
      const dsh = p.dsh as Record<string, unknown> | undefined
      if (!dsh || typeof dsh !== 'object' || Array.isArray(dsh)) errors.push('package.json: "dsh" object is required')
      else {
        const bundle = dsh.bundle as Record<string, unknown> | undefined
        if (!bundle || typeof bundle !== 'object' || bundle.patch !== './cordis.patch.yml') errors.push('package.json: dsh.bundle.patch must be "./cordis.patch.yml"')
        const engines = dsh.engines as Record<string, unknown> | undefined
        if (!engines || engines.dsh !== '>=0.1.1-rc.1') errors.push('package.json: dsh.engines.dsh must be ">=0.1.1-rc.1"')
      }
    } catch { errors.push('package.json is not valid JSON or must contain an object') }
  }

  const patch = files.find(f => f.path === 'cordis.patch.yml')
  if (!patch) errors.push('missing cordis.patch.yml')
  else {
    const lines = patch.content.split(/\r?\n/)
    const insertLine = lines.findIndex(line => /^-[ \t]*insert[ \t]*:/.test(line))
    if (insertLine < 0) errors.push('cordis.patch.yml must contain a top-level "insert:" block')
    else {
      let end = insertLine + 1
      while (end < lines.length && (lines[end]!.trim() === '' || /^[ \t]/.test(lines[end]!))) end++
      const insertBlock = lines.slice(insertLine, end).join('\n')
      const idMatch = insertBlock.match(/^[ \t]{4,}-[ \t]*id[ \t]*:[ \t]*(["']?)([a-z0-9][a-z0-9._-]{0,99})\1[ \t]*(?:#.*)?$/m)
      const nameMatch = insertBlock.match(/^[ \t]{6,}name[ \t]*:[ \t]*(["']?)([a-z0-9][a-z0-9._-]{0,99})\1[ \t]*(?:#.*)?$/m)
      if (!idMatch) errors.push('cordis.patch.yml insert block must define a row with an id')
      else if (packageName && idMatch[2] !== packageName) errors.push('cordis.patch.yml insert id must match package.json name')
      if (!nameMatch) errors.push('cordis.patch.yml insert block must define a row with a name')
      else if (packageName && nameMatch[2] !== packageName) errors.push('cordis.patch.yml insert name must match package.json name')
    }
  }

  const sourceEntry = files.find(f => f.path === 'src/index.js')
  const runtimeEntry = files.find(f => f.path === 'lib/index.js')
  if (!sourceEntry) errors.push('missing source entry: src/index.js is required')
  if (!runtimeEntry) errors.push('missing runtime entry: lib/index.js is required by package.json')
  for (const [label, entry] of [['src/index.js', sourceEntry], ['lib/index.js', runtimeEntry]] as const) {
    if (!entry) continue
    const code = stripJavaScriptCommentsAndLiterals(entry.content)
    if (!APPLY_EXPORT_RE.test(code)) errors.push(label + ' must export an "apply" symbol')
    if (!/\b(?:ctx\s*\.?\s*tools|\.?\s*tools)\s*\.\s*register\b/.test(code)) {
      errors.push(label + ' must register at least one DSH tool')
    }
  }
  if (sourceEntry && runtimeEntry && sourceEntry.content !== runtimeEntry.content) {
    errors.push('src/index.js and lib/index.js must be identical so the tested source matches the installed runtime')
  }
  return { valid: errors.length === 0, errors, warnings }
}

// ─────────────────────────────────────────────────────────────────────────────
// Repo discovery (parity with reference analyze_repo.py)
// ─────────────────────────────────────────────────────────────────────────────

export async function discoverRepo(repoRoot: string): Promise<{
  ok: true
  candidates: DiscoveryCandidate[]
  summary: { fileCount: number; candidateCount: number; limitReached: boolean }
} | { ok: false; error: string }> {
  const root = resolve(repoRoot)
  const { readdir, lstat } = await import('node:fs/promises')
  let rootStat
  try { rootStat = await lstat(root) } catch { return { ok: false, error: 'repo root not found: ' + root } }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { ok: false, error: 'repo root must be a real directory (not a symlink): ' + root }
  }

  const candidates: DiscoveryCandidate[] = []
  const MAX_DISCOVERY_ENTRIES = 10_000
  const MAX_CANDIDATES = 500
  const ignoredDirs = new Set([
    '.git', 'node_modules', 'dist', 'lib', 'build', 'coverage', 'vendor',
    '.next', '.cache', '.turbo', '.venv', 'venv', 'target', 'out',
  ])
  let visitedEntries = 0
  let scannedFileCount = 0
  let limitReached = false

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5 || limitReached || candidates.length >= MAX_CANDIDATES) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (limitReached || candidates.length >= MAX_CANDIDATES) return
      visitedEntries++
      if (visitedEntries > MAX_DISCOVERY_ENTRIES) { limitReached = true; return }
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) await walk(join(dir, entry.name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      scannedFileCount++
      const name = entry.name
      if (!/\.(md|markdown|yaml|yml|json)$/i.test(name)) continue
      const rel = join(dir, name).slice(root.length + 1).split(/[\\/]/).join('/')
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
  return {
    ok: true,
    candidates,
    summary: { fileCount: scannedFileCount, candidateCount: candidates.length, limitReached },
  }
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
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (available: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(available)
    }
    const child = spawn('bwrap', ['--version'], { stdio: 'ignore', detached: true })
    child.once('close', code => finish(code === 0))
    child.once('error', () => finish(false))
    timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* process may have exited */ }
      finish(false)
    }, 3000)
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
    const appendBounded = (current: string, chunk: unknown): string => {
      if (current.length >= MAX_CAPTURE_CHARS) return current
      const remaining = MAX_CAPTURE_CHARS - current.length
      return current + String(chunk).slice(0, remaining)
    }
    child.stdout?.on('data', d => { stdout = appendBounded(stdout, d) })
    child.stderr?.on('data', d => { stderr = appendBounded(stderr, d) })
    const safeTimeoutMs = Number.isFinite(opts.timeoutMs)
      ? Math.max(100, Math.min(5 * 60_000, Math.floor(opts.timeoutMs)))
      : 60_000
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }
    }, safeTimeoutMs)
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
    const entry = files.find(f => f.path === 'lib/index.js')?.path
    if (!entry) return { passed: false, exitCode: null, stdout: '', stderr: 'no lib/index.js runtime entry', durationMs: 0, checkedAt }

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

    const bwrapArgs: string[] = [
      '--clearenv',
      '--unshare-user',
      '--unshare-pid',
      '--unshare-net',
      '--tmpfs', '/',
    ]
    // Build an allowlisted, read-only system view. The empty root is critical:
    // bind-mounting only /usr and /lib without tmpfs / still exposes the host disk.
    for (const p of ['/usr', '/etc']) {
      if (await exists(p)) {
        bwrapArgs.push('--dir', p, '--ro-bind', p, p)
      }
    }
    for (const p of ['/lib', '/lib64', '/bin', '/sbin']) {
      if (!(await exists(p))) continue
      const { lstat, readlink } = await import('node:fs/promises')
      const info = await lstat(p).catch(() => null)
      if (!info) continue
      if (info.isSymbolicLink()) {
        bwrapArgs.push('--symlink', await readlink(p), p)
      } else {
        bwrapArgs.push('--dir', p, '--ro-bind', p, p)
      }
    }

    // Bind-mount the node binary directly into the sandbox's /tmp to avoid
    // creating --dir entries for host path segments (e.g. /home on nvm installs)
    // that would leak the host directory structure. Placed after --tmpfs /tmp so
    // the bind-mount overlays the empty tmpfs at that path.
    const nodeBinary = process.execPath

    bwrapArgs.push(
      '--dir', '/tmp',
      '--tmpfs', '/tmp',
      '--dir', workDir,
      '--bind', workDir, workDir,
      '--dir', '/proc',
      '--proc', '/proc',
      '--dir', '/dev',
      '--dev', '/dev',
      '--chdir', workDir,
      '--setenv', 'HOME', '/tmp',
      '--setenv', 'TMPDIR', '/tmp',
      '--setenv', 'PATH', '/tmp:/usr/local/bin:/usr/bin:/bin',
    )

    if (await exists(nodeBinary)) {
      bwrapArgs.push('--ro-bind', nodeBinary, '/tmp/node')
    }

    bwrapArgs.push(
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
    if (typeof description !== 'string' || description.trim() === '') return { error: 'plugin description is required' }
    if (description.length > MAX_DESCRIPTION_CHARS) return { error: 'plugin description exceeds ' + MAX_DESCRIPTION_CHARS + ' characters' }
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
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(chosenProfile)) {
    return { ok: false, error: 'invalid DSH profile name; use letters, digits, underscore, or hyphen (max 64 chars)' }
  }
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
  if (activeFibers.has(id)) return { ok: false, error: 'plugin is already active in this host' }
  if (!record.validation?.valid) return { ok: false, error: 'cannot activate: static validation must pass first' }
  if (!record.test?.passed) return { ok: false, error: 'cannot activate: sandbox test must pass first' }

  // Never trust installPath loaded from mutable JSON; derive the path from the
  // configured store root and record ID, and recreate the tree to remove symlinks
  // or stale files left by a previously interrupted write.
  const installPath = join(deps.store.getRoot(), 'installed', id)
  const runtimeEntry = record.files.find(f => f.path === 'lib/index.js')
  if (!runtimeEntry) return { ok: false, error: 'record has no lib/index.js runtime entry' }
  const entryPath = join(installPath, runtimeEntry.path)
  try { await rm(installPath, { recursive: true, force: true }) } catch { /* recreate below; writes still fail closed */ }
  for (const f of record.files) {
    const target = containPath(installPath, f.path)
    if (target === null) return { ok: false, error: 'unsafe file path: ' + f.path }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, f.content, { encoding: 'utf8', mode: 0o644 })
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
  try {
    if (typeof fiber.dispose === 'function') await fiber.dispose()
  } catch (e) {
    return { ok: false, error: 'plugin disposal failed: ' + (e instanceof Error ? e.message : String(e)) }
  }
  activeFibers.delete(id)
  const record = await deps.store.get(id)
  const status = record?.install?.installed ? 'installed' : record?.test?.passed ? 'tested' : 'validated'
  await deps.store.update(id, { status, active: undefined })
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
  // Export stored record content, never an installPath loaded from persisted JSON
  // or mutable files that may have appeared in the installed directory.
  const srcPath = await mkdtemp(join(tmpdir(), 'forge-export-'))
  try {
    for (const f of record.files) {
      const target = containPath(srcPath, f.path)
      if (target === null) return { ok: false, error: 'unsafe file path: ' + f.path }
      await mkdir(dirname(target), { recursive: true, mode: 0o755 })
      await writeFile(target, f.content, { encoding: 'utf8', mode: 0o644 })
    }
    const safeRecordName = /^[a-z0-9][a-z0-9._-]{0,99}$/.test(record.name) ? record.name : 'plugin'
    const out = resolve(outPath ?? join(deps.store.getRoot(), 'exports', `${safeRecordName}-${id}.tgz`))
    if (containPath(srcPath, out) !== null) return { ok: false, error: 'export path must be outside the staging directory' }
    await mkdir(dirname(out), { recursive: true })
    const r = await spawnProcess('tar', [
      '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '-czf', out, '-C', srcPath, '.',
    ], { timeoutMs: 30_000 })
    if (r.exitCode !== 0) return { ok: false, error: 'tar failed: ' + r.stderr.slice(0, 500) }
    return { ok: true, outPath: out }
  } finally {
    await rm(srcPath, { recursive: true, force: true }).catch(() => { /* ignore */ })
  }
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
