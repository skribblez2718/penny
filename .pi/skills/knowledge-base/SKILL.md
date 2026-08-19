---
name: knowledge-base
description: Private advisory knowledge-base workflows. Use when the operator explicitly asks to initialize, ingest approved sources, query, save, lint, inspect, resume, or prepare promotion for a configured KB profile. Do not use for canonical current-state lookup without verification, automatic research ingestion, arbitrary filesystem access, or unapproved canonical writes.
license: MIT
metadata:
  version: "1.0.0"
  penny:
    engine: orchestration
    entrypoint: pi-tool
    tool: knowledge_base
    mempalace: metadata-only
    subagents:
      - echo
      - synthia
      - carren
      - vera
      - piper
      - skribble
    actions:
      - init
      - ingest
      - query
      - save
      - lint
      - promote
      - status
      - resume
---

## When to Use

- The operator explicitly asks to initialize a configured private KB.
- The operator asks to ingest host-approved sources into a KB.
- The operator asks to query, save, or lint a KB.
- The operator asks to inspect safe run status or resume an eligible run.
- The operator asks to prepare a promotion (not apply — apply is host-only).

## When Not to Use

- Canonical current-state lookup that lacks verification: use the AGENTS.md index chain.
- Automatic research ingestion: research/ is human-directed point-in-time material.
- Arbitrary file, URL, root, provider, or target discovery.
- Raw KB-body retrieval: no action returns a raw private body.
- A request to approve/apply a promotion through model-visible input.

## Invocation

Invoke through the `knowledge_base` tool:

```
knowledge_base({schema_version: 1, action: "init", kb_profile_id: "kbp_demo", create: true, title: "Demo advisory KB"})
knowledge_base({schema_version: 1, action: "ingest", kb_profile_id: "kbp_demo", source_capability_ids: ["src_cap_1"]})
knowledge_base({schema_version: 1, action: "query", kb_profile_id: "kbp_demo", query: "...", answer_delivery: "artifact_ref"})
knowledge_base({schema_version: 1, action: "query", kb_profile_id: "kbp_demo", query: "...", answer_delivery: "parent_tool_result"})
knowledge_base({schema_version: 1, action: "save", kb_profile_id: "kbp_demo", query_run_id: "run_1", page_kind: "synthesis", title: "..."})
knowledge_base({schema_version: 1, action: "lint", kb_profile_id: "kbp_demo", mode: "deterministic_and_semantic"})
knowledge_base({schema_version: 1, action: "promote", kb_profile_id: "kbp_demo", page_revisions: [{page_id: "page_1", revision_id: "rev_1"}], canonical_target_capability_ids: ["target_cap_1"]})
knowledge_base({schema_version: 1, action: "status", kb_profile_id: "kbp_demo", run_id: "run_1"})
knowledge_base({schema_version: 1, action: "resume", kb_profile_id: "kbp_demo", run_id: "run_1"})
```

## Authority

The model may name an opaque `kb_profile_id` and, where applicable, opaque capability IDs the host already minted. It may never supply a filesystem root, source path, canonical target, provider choice, approval decision, or receipt body. Those are host-owned.

## Gates

- Profile/policy/capability checks before private reads.
- Deterministic validation before semantic work.
- Content review before ingest/save publication.
- Signed host approval before canonical apply.

## Outputs

Expected outputs are safe action status, opaque IDs/counts, bounded warnings/unresolved items, evidence or artifact handles, and — only for an explicitly host-granted, policy-permitted query — a bounded derived advisory answer with citations, uncertainty, contradictions, and a canonical-verification reminder. No output may contain a raw private body.

## Refusals

Refuse rather than guess when: the profile is ungranted, missing, changed, or unsafe; a source/target capability is invalid; policy/model checks fail; a request supplies forbidden authority-shaped input; a requested parent answer lacks host grant or policy; a phase cannot return the required typed result; or promotion approval/apply is requested through the public tool.
