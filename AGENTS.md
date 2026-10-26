# AGENTS.md — Agent interface for dsh-forge

This file describes how AI agents should operate this repository.

## What this repo is

`dsh-forge` is a DeepSeek Harness plugin. It is itself a working DSH plugin (`apply(ctx, config)`) that provides `forge_*` tools for discovering, generating, validating, sandbox-testing, installing, activating, and packaging DSH plugins.

The `skills/` directory contains markdown reference documents that teach an AI agent how to operate the DSH plugin contract. These are **not** DSH plugin entry points — they are static reference docs.

## Repository layout

dsh-forge/
├── package.json                     # DSH plugin manifest (dsh.bundle.patch)
├── cordis.patch.yml                 # DSH registry row (- insert: [...])
├── src/host/                        # DSH plugin source
│   ├── index.ts                     # apply(ctx, config) entry
│   ├── config.ts                    # schemastery config
│   ├── dsh.ts                       # host surface types
│   ├── store.ts                     # file-backed record store
│   └── modules/forge/, modules/state/
├── src/lib/                         # shared utilities
├── skills/                          # markdown reference docs (agent knowledge)
│   ├── dsh-plugin-autopilot/        # orchestrator skill
│   │   ├── SKILL.md
│   │   ├── references/
│   │   └── scripts/validate_plugin.py
│   ├── agentic-repo-discovery/
│   └── host-workspace-operator/
├── submission/listing.json          # DSH profile submission evidence
├── tests/                           # vitest + python validators
└── README.md

```

## Operating rules

1. Run `npm run typecheck && npm test` before committing.
2. Run `python3 skills/dsh-plugin-autopilot/scripts/validate_plugin.py . --json` before releasing.
3. Do not weaken or delete tests to make a change pass.
4. Do not claim a test passed unless it actually ran.
5. Do not claim DSH profile approval from a local artifact.
6. Never commit secrets, credentials, or absolute user paths.
7. Preserve the DSH tool-return contract: `neutralizeDeep` on every return.
8. Preserve the fail-closed safety gates on `forge_install` and `forge_activate`.
9. When adding a new tool, add it to `src/host/modules/<module>/tools.ts` and register it in `index.ts`. Add a test.
10. When adding a new SKILL, add it to `skills/<slug>/SKILL.md` with YAML frontmatter (`name`, `description`, both non-empty). Optionally add `references/` and `scripts/`.

## Conventional commits

`feat:` `fix:` `docs:` `test:` `chore:` `refactor:` `ci:`

## What NOT to do

- Do not invent undocumented DSH manifest fields.
- Do not copy OpenAI/Codex plugin contract fields into DSH manifests.
- Do not add `mcpServers`, `apps`, or `screenshots` fields to `package.json` unless the DSH contract explicitly defines them.
- Do not disable install/activate gates "temporarily" — find and fix the underlying validation error instead.

## License

MIT
