# dsh-forge

**Build, validate, test, and package plugins for DeepSeek Harness (DSH).**

`dsh-forge` is a DSH plugin-development workflow that turns a description or an existing agentic repository into a plugin, then checks it before installation or activation. It provides discovery, LLM-assisted generation, static validation, sandbox testing, install/activation gates, exports, and submission metadata.

> **Current scope:** v0.2.0. This release targets the DSH plugin contract. MCP support is not implemented.

## Why dsh-forge?

Plugin code runs with meaningful access to its host. dsh-forge adds a repeatable workflow around that risk:

- **Discover** reusable workflows in an existing repository.
- **Generate** a plugin from a natural-language description.
- **Validate** the manifest, registry patch, entry point, paths, and file sizes.
- **Test** the plugin in a Bubblewrap (`bwrap`) sandbox with a fake host context.
- **Gate** installation and activation on successful validation and testing.
- **Export** a packaged plugin and prepare submission metadata.

Validation and sandbox tests reduce risk; they do **not** prove that a plugin is safe or compatible with every real host environment.

## Features

| Tool | What it does |
|---|---|
| `forge_discover` | Read-only analysis of a repository to identify promising plugin workflows |
| `forge_generate` | Generates a plugin from a text description using the configured host LLM |
| `forge_validate` | Checks the DSH package contract, `cordis.patch.yml`, `apply` export, path safety, and file-size limits |
| `forge_test` | Runs a shallow sandbox test: imports the entry point and calls `apply` with a fake context |
| `forge_install` | Installs a plugin through `dsh plugin add`, subject to the validation/test gates |
| `forge_uninstall` | Removes a plugin through `dsh plugin remove` |
| `forge_activate` | Mounts a plugin in the current host through `ctx.plugin(module)`, subject to the gates |
| `forge_deactivate` | Disposes the active plugin fiber |
| `forge_export` | Creates a `.tgz` package |
| `forge_submit` | Builds a submission packet from a validated and tested record |
| `forge_list` | Lists stored plugin records |
| `forge_inspect` | Shows details for a stored record |

## Requirements

- Node.js **22.18.0 or later** (required by the Git-install build tool)
- npm (the repository pins npm **10.9.9** as its package manager)
- A compatible DSH host; the package declares DSH **`>=0.1.1-rc.1`**
- Linux with Bubblewrap (`bwrap`) for the sandbox test workflow

The sandbox test depends on the host environment and available kernel/user-namespace features. If `bwrap` cannot run in your environment, do not treat a skipped or unavailable sandbox test as a successful test.

## Install

Install from the repository using DSH:

```bash
dsh plugin --profile web add github:mulqizamzam/dsh-forge#main
```

Or install from a local source checkout (the build runs automatically):

```bash
git clone https://github.com/mulqizamzam/dsh-forge.git
cd dsh-forge
npm ci
dsh plugin --profile web add .
```

Replace `web` with the DSH profile you intend to use.

GitHub installs run the package's `prepare` lifecycle to build `lib/index.js`; no manual build command is needed. pnpm blocks unapproved install-time build scripts by default. When DSH prints an `allowBuilds` instruction, copy the **entire package key exactly as printed** into the target profile's `pnpm-workspace.yaml` and set it to `true`. For a GitHub dependency fetched as a codeload tarball, the key can include the resolved commit URL, so a package-name-only entry such as `dsh-forge: true` may not match the artifact.

For the command you ran, first make sure your file contains this entry (merge it with any existing `allowBuilds` entries rather than replacing them):

```yaml
allowBuilds:
  'dsh-forge@https://codeload.github.com/mulqizamzam/dsh-forge/tar.gz/d260a2c078ef7ec42d1495cd51dbc6c47aa08794': true
```

This example matches commit `d260a2c078ef7ec42d1495cd51dbc6c47aa08794`. If pnpm printed a different key, use that exact key instead. Then rerun the same `dsh plugin --profile web add github:mulqizamzam/dsh-forge#main` command while `main` still resolves to that commit; otherwise pin the command to the same SHA. This permission lets the package's source execute during install, outside the sandbox. Allow only code you have reviewed and trust.

## Configuration

Example plugin configuration:

```yaml
- id: dsh-forge
  config:
    stateRoot: "" # Empty uses $DSH_HOME/dsh-forge/<profile>
    forge:
      defaultProfile: web
      sandbox:
        enabled: true
        timeoutMs: 60000
      install:
        requireValidated: true
        requireTested: true
```

Keep both install gates enabled. Setting either `requireValidated` or `requireTested` to `false` permits code to be installed or activated without that check. Only do so in a disposable environment when you understand the consequences.

## How the safety gates work

By default, both `forge_install` and `forge_activate` require:

1. **Successful static validation** — the plugin manifest and DSH contract, `cordis.patch.yml` insert block, `apply` export, path checks, and per-file size limit must pass.
2. **A successful sandbox test** — the entry point must import and `apply` must register at least one tool against a fake host context within the configured timeout.

These are preflight checks, not a security boundary for all plugin behavior. The test uses a fake context and cannot verify every real-host API interaction. Installation mutates the real DSH profile and is not run inside the sandbox. A plugin may still behave unexpectedly after installation or activation.

Read [SECURITY.md](SECURITY.md) before running plugins you did not write or audit.

## Development

Install locked dependencies and run the project checks:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run validate
```

The dependency-free Python validator can also be run directly:

```bash
python3 skills/dsh-plugin-autopilot/scripts/validate_plugin.py . --json
```

CI runs the automated test, type-check, plugin-contract validation, and dependency-audit workflow. See [GitHub Actions](https://github.com/mulqizamzam/dsh-forge/actions).

## State and generated artifacts

By default, records are stored under:

```text
$DSH_HOME/dsh-forge/<profile>/
├── records/<id>.json
├── installed/<id>/
└── exports/<name>-<id>.tgz
```

- `records/` stores plugin records and their validation, test, install, and activation state.
- `installed/` stores materialized plugin files used for installation.
- `exports/` stores generated `.tgz` archives.

Set `stateRoot` to use a different state directory.

## Included skills and references

- [DSH plugin autopilot](skills/dsh-plugin-autopilot/SKILL.md) — plugin generation and validation workflow
- [Agentic repository discovery](skills/agentic-repo-discovery/SKILL.md) — finding reusable workflows in repositories
- [Host workspace operator](skills/host-workspace-operator/SKILL.md) — routing work through host-native capabilities
- [Official DSH contract reference](skills/dsh-plugin-autopilot/references/dsh-official-contract.md) — contract notes used by the workflow
- [Submission listing template](submission/listing.json) — metadata template for submission preparation

## Known limitations

- **Generation can fail.** LLM output may be empty, malformed, or inconsistent with the contract; generated plugins still need review.
- **Sandbox testing is shallow.** It checks import and basic tool registration against a fake context, not full behavior in a production DSH host.
- **Installation is not sandboxed.** Installing changes the selected DSH profile.
- **Uninstall is not a full rollback.** It removes the plugin from the profile but cannot undo arbitrary external side effects or clean files the plugin wrote elsewhere.
- **MCP support is out of scope** for v0.2.0.

## License

[MIT](LICENSE)
