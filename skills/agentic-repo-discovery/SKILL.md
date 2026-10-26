---
name: agentic-repo-discovery
description: Use when an existing repository contains agents, prompts, workflows, playbooks, commands, or reference docs, and you need to identify which capabilities should become DSH plugin tools or reference docs. Use before generating any DSH plugin skeleton.
---

# Agentic Repo Discovery

Find the reusable user workflows inside a repository **before** creating any DSH plugin files.

## Procedure

1. Read repository instructions and the main README first.
2. Run discovery via the `forge_discover` tool (or the bundled `analyze_repo.py` reference script when the host has Python).
3. Inspect high-scoring candidates in context. Discovery signals intent; it does not understand the full product by itself.
4. Assign each candidate a disposition:
   - `preserve` — keep as-is if it is already a valid DSH plugin component
   - `compile_skill` — convert into a DSH plugin tool or reference doc
   - `reference_only` — keep as a markdown reference but do not execute
   - `discard` — not worth carrying forward
5. For every candidate, articulate the user's repeatable job. Reject candidates whose only value is repository maintenance trivia unless the DSH plugin's explicit purpose is that.
6. Flag secrets, organization-specific instructions, destructive operations, security-sensitive workflows, and policy-sensitive capabilities for explicit public-distribution review.
7. Recommend an architecture from actual behavior, not from stray files in the repository:
   - `tools-only` — the plugin registers DSH tools to do the work
   - `reference` — the plugin is a documentation pack with no runtime tools
   - `hybrid` — tools plus reference docs
8. Hand selected workflow candidates to `workflow-to-skill-compiler` and the overall product boundary to `plugin-experience-architect`.

## Output

Return a conversion brief with:

- repository/ref inspected
- reusable jobs discovered
- candidate dispositions with reasons
- architecture recommendation with confidence
- runtime dependencies
- public exclusions
- missing evidence
- next conversion actions

Do not generate DSH plugin config before this boundary is clear.
