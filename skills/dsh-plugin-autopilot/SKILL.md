---
name: dsh-plugin-autopilot
description: Use when converting an agentic repository into a DeepSeek Harness (DSH) plugin, or when building, repairing, validating, packaging, installing, activating, or auditing an existing DSH plugin. Covers the DSH plugin contract, sandbox isolation, deterministic packaging, and submission evidence for a DSH profile.
---

# DSH Plugin Autopilot

Take an arbitrary repository from workflow discovery to a verified DSH plugin artifact and, when explicitly authorized, through profile submission.

This Skill mirrors the OpenAI/Codex Plugin Autopilot discipline but is adapted to the **DeepSeek Harness plugin contract**:

- manifest lives in `package.json` with `dsh.bundle.patch`
- registry row lives in `cordis.patch.yml` (`- insert: [{ id, name, config }]`)
- entry point is a TypeScript module exporting `apply(ctx, config)` (built to `lib/index.js`)
- tools are registered via `ctx.tools.register(def)` with a lossless-JSON return contract
- settings are registered via `ctx.settings.register(ns, schema, { applies: 'live' })`
- activation uses `ctx.plugin(module, config)` and `ctx.provide(name, value)`
- there is **no marketplace approval** — a locally validated ZIP is not a public marketplace listing

## Operating contract

1. Verify the current DSH plugin contract against `references/dsh-official-contract.md`. Do not infer contract details from OpenAI/Codex documentation — DSH is a different surface.
2. Inspect repository instructions, package metadata, manifests, skills, agents, workflows, hooks, assets, legal/support docs, CI, and release scripts before changing anything.
3. When the repository is not already a coherent DSH plugin, run discovery first via the `forge_discover` tool or the equivalent `analyze_repo.py` reference. Classify candidates and set the public boundary.
4. Choose the smallest architecture that delivers the requested user outcome. `skills-only` (markdown references only), `tools-only` (DSH plugin with tool registrations), or `hybrid` (tools + reference skill docs).
5. Compile selected workflows into DSH plugin tools. Preserve decision logic, approvals, tests, evidence, and stop conditions.
6. Preserve the DSH tool-return contract: every returned value must be lossless JSON. Strip `undefined`, non-finite numbers, cycles, and brace-pair sequences from model-visible strings.
7. When host-native Python is available, prefer deterministic execution over mental simulation for parsing, hashing, archive inspection, and validation. Use `sandbox-python-executor`-style discipline even when DSH host exposes no in-process Python.
8. Add `assets/logo-light.svg`, `assets/logo-dark.svg`, and a compact square icon. Light and dark must share geometry — not two separate concepts.
9. Prepare listing metadata for a DSH profile (name, subtitle, description, developerName, version, packageName, capabilities, starter prompts). Mark publisher/legal facts as blockers when missing rather than inventing them.
10. Enforce package shape before copy polish:
    - only `package.json` + `cordis.patch.yml` + `lib/` + optional `skills/`, `docs/`, `assets/`, `submission/`
    - no path traversal, no absolute paths, no symlinks, no hidden secrets
    - every `SKILL.md` is valid YAML frontmatter with non-empty `name` and `description`
11. Install requires static validation AND a sandbox test to have passed. Never install unvalidated plugins — `dsh plugin add` mutates the user's real profile.
12. Activation requires the same gates. Never mount code that has not been validated and sandbox-tested.
13. Build the artifact deterministically. Two builds from the same source must have the same SHA-256.
14. Report exact commit/version, hashes, executed tests, skipped checks, remote status, and residual warnings. Never claim "approved" or "published" from local validation alone.

## Package preflight

Check at minimum:

- `.codex-plugin/plugin.json` equivalent: `package.json` includes `dsh.bundle.patch: "./cordis.patch.yml"` and `dsh.engines.dsh` set
- `cordis.patch.yml` contains a top-level `insert:` block with an id matching `package.json.name`
- `lib/index.js` exists and exports `apply`
- `src/host/index.ts` (source) or `lib/index.js` (built) contains `ctx.tools.register` or `.tools.register` (at least one tool is registered)
- every returned tool value satisfies the host lossless-JSON contract (`neutralizeDeep`)
- no absolute user paths, no symlinks, no bytecode, no secrets
- deterministic packager produces the same bytes from the same source
- `forge_install` and `forge_activate` both reject when `validation.valid !== true` or `test.passed !== true`

## Sandbox rules

The sandbox is `bwrap`-based, same discipline as the reference:

- `--clearenv`, `--unshare-pid`, `--unshare-net`
- `--ro-bind` for `/usr`, `/lib`, `/lib64`, `/bin`, `/sbin`
- `--ro-bind` for `dirname(process.execPath)` so version-managed Node works
- `--bind` for the candidate work directory only
- the spawned process is `detached: true`, and timeout sends `SIGKILL` to the whole process group (`process.kill(-pid, 'SIGKILL')`), not just the direct child — otherwise `node` grandchildren inside bwrap survive
- if `bwrap` is unavailable, the tool fails closed rather than running without isolation

## Host tool return contract

Every tool return value is snapshotted by the host with a lossless-JSON validator. A tool return that contains `undefined`, `NaN`, `Infinity`, `-0`, a cycle, a sparse array, or a non-plain object fails the entire call with "value is not lossless JSON" — the tool ran, but the caller never sees its result.

- always run returns through `neutralizeDeep`
- brace-pair sequences (`{{`, `}}`) are stripped from strings AND object keys
- `undefined` values are dropped (not converted to null); use `null` explicitly when the field must exist
- arrays keep their length: `undefined` items become `null`

## Host Python rule

If the host provides a Python tool, execute deterministic checks instead of mental simulation. If Python is unavailable, say so and mark execution-dependent conclusions unverified. Do not fabricate stdout, hashes, or pass/fail results.

## Submission readiness

A DSH profile submission packet (`forge_submit`) contains:

- source record id
- packageName, version
- capabilities (tool names extracted from `src/index.js`)
- starter prompts
- publisher fields the operator must verify out-of-band (`developerName`)

Never collapse these states into one:

- `validated` — static validation passed
- `tested` — sandbox test passed
- `installed` — `dsh plugin add` succeeded
- `active` — `ctx.plugin` mount succeeded
- `submitted` — packet handed to profile maintainers
- `approved` — profile accepted the plugin
- `published` — plugin surfaced in a public or team listing

A valid ZIP, a good logo, a successful mount, or a green CI run is **not** approval.

## Learned failure patterns that must stay covered

- `activatePlugin` that patches `ctx.tools.register` for tool-name capture MUST restore it in `finally`, not only on error — otherwise the closure leaks on every activation
- `spawnProcess` timeout MUST use `detached: true` + group `SIGKILL`, or grandchildren survive after a `forge_test` timeout
- `callHostLLM` MUST retry once on empty content — thinking routes can spend the whole budget on reasoning and return empty output
- `extractFileSet` MUST surface "files array exists but all entries invalid" instead of a generic "no files array" message
- `forge_install` MUST be gated on validation + test, because `dsh plugin add` mutates the user's real profile
- `forge_activate` MUST be gated on validation + test, because `ctx.plugin` executes candidate code in the running host
- `dsh plugin remove` may fail with `package not found` if the user manually removed it — the tool must surface that failure, not silently mark uninstalled

## Stop conditions

Stop before irreversible action when:

- required DSH contract cannot be verified
- repository identity is ambiguous
- credentials are unavailable
- tests/validation fail
- a target package identity already exists at a different content hash
- package identity is nondeterministic when determinism is promised
- publisher/legal listing facts are missing
- sandbox isolation is unavailable and the test requires execution

Do not weaken tests, hide uploader failures, inject credentials into CI, force-push unrelated history, or claim DSH profile approval when only a local artifact was prepared.

## Reference files

- `references/dsh-official-contract.md` — the DSH plugin contract baseline
- `references/sandbox.md` — bwrap isolation rules and process-group timeout
- `references/deterministic-packaging.md` — reproducible ZIP discipline
- `references/submission-evidence.md` — statuses and evidence checklist
