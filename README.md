# dsh-forge

**DSH plugin factory.** Discover, generate, validate, sandbox-test, install, activate, and export DeepSeek Harness plugins — with a full-parity discipline adapted from `chatgpt-codex-plugin-autopilot`.

> **Status:** v0.2.0. DSH-adapted. Full-parity structure: fail-closed validation, deterministic packaging, submission evidence, and reviewer-grade documentation. MCP explicitly out of scope for v0.2.

## What's new vs v0.1.0

- **C1 fix**: `activatePlugin` restores `ctx.tools.register` on the success path via `finally`, not only on error.
- **H1 fix**: `spawnProcess` uses `detached: true` + `process.kill(-pid, 'SIGKILL')` on timeout, so `node` grandchildren inside `bwrap` cannot survive a `forge_test` timeout.
- **H2 fix**: `callHostLLM` retries once with a directive when the first attempt returns empty output (thinking routes commonly exhaust the token budget on reasoning).
- **H3 fix**: `extractFileSet` surfaces "files array exists but all entries invalid" instead of the misleading "no files array".
- **M2 fix**: per-file size cap of 1 MiB in `validatePlugin`.
- **L2 fix**: `uninstallPlugin` restores `tested` status instead of `installed`.
- **New tool** `forge_discover` — read-only repo analysis (parity with `analyze_repo.py`).
- **New tool** `forge_submit` — submission packet builder (parity with `build_directory_pack.py`).
- **New skill** `skills/dsh-plugin-autopilot/SKILL.md` + `references/dsh-official-contract.md` — the DSH contract, adapted from the OpenAI/Codex reference.
- **New skill** `skills/agentic-repo-discovery/SKILL.md` — workflow discovery discipline.
- **New skill** `skills/host-workspace-operator/SKILL.md` — host-native capability routing.
- **New** `skills/dsh-plugin-autopilot/scripts/validate_plugin.py` — Python validator (dependency-free) usable from CLI or CI.
- **New** `submission/listing.json` — submission evidence packet template.

## Tools

| Tool | Purpose |
|---|---|
| `forge_discover` | Read-only repo analysis: find DSH-plugin-worthy workflow candidates |
| `forge_generate` | LLM generates a complete DSH plugin from a text description |
| `forge_validate` | Static validation: `package.json` dsh contract, `cordis.patch.yml` insert block, `apply` export, path safety, size cap |
| `forge_test` | bwrap sandbox: import entry, call `apply` with fake ctx, require ≥1 tool registered, process-group timeout |
| `forge_install` | `dsh plugin add <path>` — **GATED on validate + test** |
| `forge_uninstall` | `dsh plugin remove <pkg-name>` — restores previous status |
| `forge_activate` | `ctx.plugin(module)` — mount in current host — **GATED on validate + test** |
| `forge_deactivate` | Dispose the mounted fiber |
| `forge_export` | Package as `.tgz` via `tar -czf` |
| `forge_submit` | Build a submission packet (listing metadata) for a validated + tested record |
| `forge_list` | List stored records |
| `forge_inspect` | Full record details |

## Safety — the install gate

`forge_install` and `forge_activate` both require:

1. `record.validation.valid === true` — `package.json` dsh contract, `cordis.patch.yml` insert block, `apply` export, path safety, size cap.
2. `record.test.passed === true` — bwrap-sandboxed, `apply()` called with a fake ctx, ≥1 tool registered, process-group timeout on failure.

Both gates are configurable (`forge.install.requireValidated`, `forge.install.requireTested`) but **do not disable them**. Disabling either gate means `dsh plugin add` or `ctx.plugin` runs against un-vetted code that can modify your profile or your running host.

## Config

```yaml
- id: dsh-forge
  config:
    stateRoot: ""              # empty = $DSH_HOME/dsh-forge/<profile>
    forge:
      defaultProfile: web
      sandbox:
        enabled: true
        timeoutMs: 60000
      install:
        requireValidated: true
        requireTested: true
```

## State layout

```
$DSH_HOME/dsh-forge/<profile>/
├── records/<id>.json    # ForgeRecord (files, validation, test, install, active)
├── installed/<id>/      # materialized plugin files ready for dsh plugin add
└── exports/<name>-<id>.tgz
```

Set `stateRoot` to override the default.

## Install

```
dsh plugin --profile web add github:<you>/dsh-forge#main
```

## Build from source

```
git clone <this repo>
cd dsh-forge
npm install
npm run build
dsh plugin --profile web add .
```

## Development

```
npm run typecheck
npm test
npm run build
python3 skills/dsh-plugin-autopilot/scripts/validate_plugin.py . --json
```

## Full-parity mapping (vs `chatgpt-codex-plugin-autopilot`)

| Reference discipline ↕▾ | dsh-forge equivalent ↕▾ |
|---|---|
| −`.codex-plugin/plugin.json` | `package.json` with `dsh.bundle.patch` |
| −`action.yml` (GitHub Action) | `cordis.patch.yml` (DSH registry row) |
| −`skills/*/SKILL.md` (9 skills) | 3 skills + full official-contract reference (more can be added without changing the contract) |
| −`scripts/action_entrypoint.py` | `src/host/index.ts` + `src/host/modules/forge/actions.ts` |
| −`scripts/self_check.py` | `skills/dsh-plugin-autopilot/scripts/validate_plugin.py` |
| −`scripts/build_release.py` | `forge_export` (tar-based, deterministic) |
| −`submission/listing.json` | `submission/listing.json` (template) + `forge_submit` tool |
| −bwrap sandbox in skill scripts | `testInSandbox` in `actions.ts` |
| −Fail-closed validation | `validatePlugin` in `actions.ts` |
| −Lossless JSON tool returns | `neutralizeDeep` in `src/lib/sanitize.ts` |
| −Process-group SIGKILL on timeout | `spawnProcess` in `actions.ts` |

**DSH-specific adaptations not present in the reference:**

- Manifest is `package.json` with `dsh.bundle.patch`, not `.codex-plugin/plugin.json`.
- Registry is `cordis.patch.yml` with `- insert:` block, not `marketplace.json`.
- Activation is `ctx.plugin(module, config)`, not OpenAI marketplace install.
- Settings live-scope is `ctx.settings.register(ns, schema, { applies: 'live' })`.
- Host Python is unavailable in-process; sandbox is `bwrap` via `spawn`.
- "Submission" means DSH profile review, not OpenAI marketplace approval.

## Known limitations (v0.2.0)

- **LLM generation quality.** Contract is injected; expect ~10–20% retry rate on empty content, plus occasional invalid JSON. Validation catches most issues.
- **Sandbox test is shallow.** It imports the entry and calls `apply` with a fake `ctx`. A plugin that passes can still fail against the real host (missing service, wrong API shape).
- **Install is un-sandboxed.** `dsh plugin add` must mutate the real DSH profile, so it runs outside `bwrap`. The only protection is the validate + test gate.
- **No install rollback.** `forge_uninstall` removes the plugin from the profile, but files the plugin wrote outside its own directory are not cleaned up.
- **MCP is not implemented.** Explicitly out of scope for v0.2.

## License

MIT
