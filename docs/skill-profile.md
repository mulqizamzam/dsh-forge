# dsh-forge Skill Profile

> Adaptation of the `OmniSkill Profile` pattern from `chatgpt-codex-plugin-autopilot`, tailored to the DSH plugin contract.

## Metadata

| Field | Value |
|---|---|
| **Name** | `dsh-forge` |
| **Version** | 0.2.0 |
| **Author** | dsh-forge contributors |
| **License** | MIT |
| **OmniSkill mode** | PACKAGE + VALIDATE + INSTALL + ACTIVATE |
| **Primary pattern** | Sequential + Tool-gated |

## Job

Convert agentic repositories into focused, validated, sandbox-tested, deterministically packaged DeepSeek Harness plugins — finding real workflows, deciding what is public vs internal, compiling portable DSH plugin tools, adding workspace operations, verifying with Python or bwrap when available, building a .tgz export, and preparing DSH profile submission evidence.

## Failure without this skill

Without dsh-forge, an agent asked to "package this repo as a DSH plugin" will:

- Copy every folder without boundary analysis
- Invent undocumented manifest fields (`.codex-plugin/`, `apps`, `screenshots`)
- Skip `package.json` `dsh.bundle.patch` and `cordis.patch.yml` `insert:` block
- Ship an `apply()` export that registers zero tools
- Skip deterministic packaging
- Claim sandbox testing ran without executing bwrap
- Confuse local validation with DSH profile approval
- Install or mount unvalidated code into the user's real profile

## Trigger language (positive)

| Prompt | Reason |
|---|---|
| "Turn this agentic repository into a DSH plugin" | Core job trigger |
| "Package this repo for a DSH profile" | Explicit packaging trigger |
| "Convert my AGENTS.md workflows into DSH tools" | Workflow-to-tool conversion |
| "Validate and package the DSH plugin in this repo" | Validation + packaging |
| "Build a deterministic .tgz release for this plugin" | Release discipline trigger |
| "Prepare a DSH submission packet for this plugin" | Submission trigger |
| "Run self-check and package this plugin" | Internal gate trigger |

## Near-miss negatives (must NOT trigger)

| Prompt | Reason |
|---|---|
| "Set up a new Node.js project" | Generic dev task — not plugin conversion |
| "Help me write an AGENTS.md" | Agent docs writing, not plugin packaging |
| "Create a GitHub repository" | Repo creation |
| "Fix this TypeScript bug" | Debugging |
| "Write a README for my project" | Docs writing |

## Host support matrix

| Host | Discovery | Sandbox | Deterministic export |
|---|---|---|---|
| DSH web profile | ✅ forge_discover | ✅ bwrap (fail-closed) | ✅ tar-based |
| DSH headless profile | ✅ forge_discover | ✅ bwrap (fail-closed) | ✅ tar-based |
| Node-only (no DSH host) | ✅ Python validator | ⚠️ manual | ✅ manual tar |

## Invariants

1. **Never claim a tool ran without executing it.** Show actual output or say "unavailable".
2. **Never install or mount unvalidated code.** Both gates required.
3. **Never claim DSH profile approval** from local validation.
4. **Never produce non-deterministic archives** — the same source must produce the same SHA-256.
5. **Never skip the lossless-JSON return contract.** Every tool return goes through `neutralizeDeep`.
6. **Never skip process-group SIGKILL on timeout.** `detached: true` is mandatory in `spawnProcess`.
7. **Never skip the retry-on-empty-output in `callHostLLM`.** Thinking routes exhaust the budget silently.
8. **Never weaken or delete a test** to make a change pass.

## Workflow steps

### Phase 1: Discovery (`forge_discover`)
- **Freedom**: Low — must follow the returned candidate list
- Scan `AGENTS.md`, `SKILL.md`, `playbooks/`, `commands/`, workflow-like filenames

### Phase 2: Decision
- **Freedom**: Medium — agent chooses preserve/compile/reference/discard, must justify
- Set public/private boundary; never include private material

### Phase 3: Compilation
- **Freedom**: Low for invariants, Medium for prose style
- Preserve decisions, approvals, tests, evidence, stop conditions

### Phase 4: Generation (`forge_generate`)
- **Freedom**: Low — LLM output must satisfy the DSH contract
- Retry once on empty output

### Phase 5: Validation (`forge_validate`)
- **Freedom**: None — fail-closed, no argument
- `package.json` dsh.bundle.patch, `cordis.patch.yml` insert, `apply` export, path safety, size cap

### Phase 6: Sandbox test (`forge_test`)
- **Freedom**: None — fail-closed
- bwrap, process-group timeout

### Phase 7: Install / Activate / Export
- **Freedom**: None — gated on Phase 5 + 6
- `dsh plugin add` (profile mutation), `ctx.plugin` (host mount), `tar` (export)

### Phase 8: Submit (`forge_submit`)
- **Freedom**: Low — all listing fields must be accurate
- Build packet, don't invent publisher facts

## Quality gates (BinEval)

| Dimension | Gate |
|---|---|
| Discovery | `forge_discover` returns at least one candidate for a non-empty repo |
| Clarity | Tool descriptions are one sentence, self-contained |
| Structure | All `src/host/modules/*/index.ts` exist; all tools registered |
| Robustness | Reject unvalidated install; reject untested activation; reject empty LLM content |
| Completeness | Test suite passes; `validate_plugin.py` exits 0; deterministic export produces same SHA-256 |

## Acceptance gates

```bash
npm run typecheck
npm test
python3 skills/dsh-plugin-autopilot/scripts/validate_plugin.py . --json
```

All must exit 0.
