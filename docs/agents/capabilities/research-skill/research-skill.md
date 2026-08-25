# Research Skill — Structured evidence-based research

## What

A multi-agent workflow that decomposes a query, gathers cited external evidence, synthesizes it, critiques it when budgeted, validates citation grounding in every mode, and produces a complete report artifact plus user-facing files.

## Rules

1. Use research for complex or multi-source questions, not simple lookups or implementation when sufficient evidence already exists.
2. Penny routes only. Exact execution-owner artifacts carry stage content; SUMMARY objects carry routing data.
3. Mode is caller- or model-owned. `constraints.mode` wins; otherwise Piper declares it. No keyword detector selects mode.
4. Echo ranks sources relationally (primary > reputable secondary > weak), cites material claims, and chooses search tools according to uncertainty. Video and browser-rendered sources are available but never mandatory sweeps.
5. Vera runs an evidence-gated citation check in every mode. Deep mode also budgets plan and report critique.
6. The skill returns research products, not authorization to execute recommendations.
7. Start, retry, fan-in, clarification, restart, and terminal completion must work with no memory endpoint or memory extension.

## Invocation

```typescript
skill({
  skill_name: "research",
  goal: "What are the tradeoffs of microservices vs monoliths?",
});
```

| Constraint            | Default        | Meaning                                                                                   |
| --------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `mode`                | model-declared | `quick`, `standard`, or `deep`; only explicit caller quick skips planning.                |
| `report_format`       | `default`      | Free-form shaping instruction.                                                            |
| `max_sub_queries`     | 4              | One decomposition budget, clamped to fan width.                                           |
| `max_fan_width`       | 8              | Maximum parallel Echo branches.                                                           |
| `validate_model`      | Vera default   | Optional different model for validation only.                                             |
| `critique_passes`     | mode preset    | `>=1` report critique; `>=2` plan critique.                                               |
| `max_research_rounds` | mode preset    | Initial plus evidence-seeking rounds.                                                     |
| `rigor_escalation`    | false          | Permit one earned report critique after validation difficulty without a researchable gap. |

## Engine and exact artifacts

`ResearchPlaybook` is a registered TypeScript playbook in `apps/orchestration/src/playbooks/research.ts`. The skill directory contains no executable delegate; Node SQLite checkpoint state is keyed by `run_id`.

Every cognitive directive supplies exact cross-run `input_artifacts` and an `output_artifact` contract. A worker reads needed IDs with `artifact_read` and `next_range`, then returns complete stage content. The owner persists/re-reads exact response bytes before parsing the final SUMMARY line. Read-only memory is advisory only; payloads never enter `RunContext`.

The playbook selects all exact predecessor refs required by a consumer, not only reviewer metadata. Parallel research captures one artifact per `branch_id`; fan-in is order-independent. Artifact revisions, selected refs, and per-state inputs survive malformed-SUMMARY retry, clarification, and fresh-process recovery.

The final Skribble output includes the complete contents of `report.md`, `sources.md`, and `README.md`. Its selected `report_writing` ref is returned as `output_artifact_ref` and is the registered product artifact. The same contents remain in the three user-facing files.

## Flows

- **Quick:** intake → researching → synthesizing → validating → report_writing → complete
- **Standard:** intake → planning → researching → synthesizing → validating → report_writing → complete
- **Deep:** intake → planning → critiquing_plan → researching → synthesizing → critiquing_report → validating → report_writing → complete

`researching` is a dynamic fan bounded by `max_fan_width`. Vera may return `evidence_needed`, which drives a bounded evidence-seeking fan before re-synthesis and re-validation. Mode sets budgets, not a fixed sub-query count.

## Loops, clarification, and terminal truth

Plan critique, report critique, and validation loops are bounded by `max_iterations`. Repeated identical issues escalate. Exhaustion records warnings and unresolved issues; it never produces fake approval.

Clarification resumes the producer that can act: planning/plan critique → planning; research → research; synthesis/report critique/validation → synthesis. The same run and exact selected refs are retained.

Terminal fields distinguish delivery and verification:

- `met`: final report production completed;
- `grounded`: Vera's final verdict passed;
- `output_artifact_ref`: exact checkpointed product artifact;
- `report_dir` / `report_files`: user-facing files;
- warnings, exhaustion flags, and unresolved issues: honest limitations.

## Verification

- `research-parity.test.ts`: mode traces, dynamic fan, critique, re-research, clarification, recovery, and terminal truth.
- `core-runtime.test.ts`: exact artifacts, receipts, malformed reissue, and memory-absent execution.
- `prompt-guidance-contract.test.ts`: complete phase-prompt alignment.
- `flow-diagrams.test.ts`: descriptor/diagram parity.
