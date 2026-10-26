---
name: host-workspace-operator
description: Use when a DSH plugin's workflow needs to inspect, search, modify, or verify files in the host workspace using the safest native tools available.
---

# Host Workspace Operator

DSH host tools differ from OpenAI/Codex surface. This Skill expresses intent by capability and lets the host map intent to the actual tool.

## Capability order

Prefer the narrowest operation that can answer the task:

1. **read** — open a known file or exact range
2. **list** — enumerate a directory or workspace scope when filenames are unknown
3. **search** — semantic/content search when the user asks a broad question
4. **grep** — exact text/regex/symbol lookup when the term is known
5. **patch** — focused edit to an existing file
6. **write** — create or replace a file when the workflow requires a mutation
7. **shell** — run repository commands when file tools are insufficient
8. **python** — deterministic parsing, hashing, archive inspection, or validation

Do not use shell or Python just to imitate a safer file/search operation the host already provides.

## Read-only first

Read, list, search, grep are the default discovery phase. Inspect enough evidence to understand current state before mutation.

For repository work:

- inspect repository instructions before editing
- prefer exact file/range reads after a search locates the relevant section
- avoid loading dependency/build trees without need
- honor ignored/generated/vendor directories when searching

## Mutation boundary

Write, patch, delete, move, rename, format, or mutating shell commands are **mutation** operations.

Before mutation:

- confirm the user requested or clearly authorized the change
- respect repository instructions and existing scope
- preserve unrelated work
- prefer a focused patch over full-file replacement
- never write secrets into source, manifests, logs, examples, or release artifacts

After mutation:

- read the changed area back when practical
- run the relevant verifier/test when available
- report the exact files changed and verification evidence

## Tool-unavailable behavior

If a required host tool is unavailable:

- do not invent a replacement tool name or undocumented DSH manifest field
- do not claim read/write/search/grep/shell/Python activity occurred
- use another available capability only when it preserves the task semantics and safety boundary
- otherwise state which operation is unavailable and keep dependent conclusions unverified

## DSH-specific note

DSH host tools (`ctx.tools.register`) have a lossless-JSON return contract. A plugin that "reads a file" must return the file content as a plain string, not a Buffer or stream — the host snapshots the return value.
