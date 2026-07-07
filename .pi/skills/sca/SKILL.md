---
name: sca
description: "Multi-phase secure code analysis of cloned source repositories — charter, census, threat modeling, targeted scanning, triage, deep dive, verification, and reporting. Use when the task requires a deep, gated security review of a local source tree — signals like 'security review this repo', 'audit the codebase', 'threat model', 'secure code review', 'analyze this source for vulns'. Do not use when analyzing JavaScript pulled from live URLs (the jsa skill), performing network scanning, or targeting non-source artifacts."
license: MIT
metadata:
  version: "2.0.0"
  penny:
    engine: orchestration
    mempalace: true
    subagents:
      - echo
      - synthia
      - tabitha
      - annie
      - vera
      - skribble
---

# sca — Secure Code Analysis

Multi-agent, gated secure code analysis of **cloned source repositories**. An
engine-backed `BasePlaybook` subclass (`ScaPlaybook`) drives a strictly
sequential 13-phase pipeline from charter through report, pausing at six human
gates for approval. Run state lives in the engine's durable checkpointer keyed
by `run_id`; `scripts/orchestrate.py` is a thin delegate to the shared
orchestration engine. Agents communicate via mempalace; Penny receives only
structured summaries. See `resources/reference.md` and `resources/flow.mmd`
for the full state/transition/gate map.

## When to Use

- Deep security review of a local, cloned source tree (any language)
- Threat-model-driven analysis: charter → census → context → architecture →
  requirements → threat model → targeted scan → triage → deep dive →
  verification → fix verification → report
- When you need human sign-off gates at charter, context, threat model,
  triage, before verification, and at final report
- When you need a resumable, auditable pipeline with per-phase mempalace rooms

## When NOT to Use

- **JavaScript from live URLs** — use the `jsa` skill instead. The boundary is
  the input: `sca` analyzes **cloned source repos** on disk; `jsa` analyzes
  **JavaScript acquired from live URLs**.
- Network-level scanning, subdomain discovery, or non-source targets
- Simple grep/lint passes (this is deep, multi-step, gated analysis)

## Invocation

Invoke via the `skill` tool. The skill extension handles orchestration —
agents communicate via mempalace, Penny receives structured summaries.

```
skill({
  skill_name: "sca",
  goal: "/path/to/cloned/repo",
  project_root: "/path/to/project",
  constraints: {
    target_path: "/path/to/cloned/repo",
    output_dir: "/tmp/sca-myrepo"
  }
})
```

Output defaults to `/tmp/sca-{repo_basename}-{shorthash}` (the shorthash is a
sha256 of the resolved abspath, so distinct repos never collide) and is never
written into the project tree. Run state (current phase, cleared gates,
augment counter, phase results) is persisted by the engine checkpointer keyed
by `run_id`, so the pipeline is resumable across subprocess boundaries and
context resets. There is no `/tmp` session file, no `--state` argv, and no
`orchestrator_state` to thread through.

## Escalation & resume

If an agent phase reports `needs_clarification`, the playbook pauses on the
engine's HITL path. Resume by re-invoking with the same `run_id` and a
`user_response`; the run lands back on the exact escalating phase — you do not
pass an `orchestrator_state`.

## Mempalace

Inter-agent exchange goes through MemPalace under wing `wing_sca`, with a
per-phase room `<session_id>-<phase_name_lowercased>`. Each deterministic scan
also emits a mempalace drawer stub in the result payload
(`mempalace_stubs`) for Penny to replay post-completion. The engine records
run outcomes automatically — no manual `memory_add_drawer` / `memory_kg_add`
bookkeeping is required at the end of a run.
