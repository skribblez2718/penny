---
name: assess
description: "Create one durable evidence-linked categorical assessment of a closed inline target against supplied required/advisory criteria and supplied evidence. Use when the caller wants strengths, gaps, uncertainties, and bounded improvement advice without external verification. Do not use to invent numeric scores, gather evidence, execute checks, start changes, write files, mutate anything, or assess an open/unsupplied target."
metadata:
  penny:
    engine: orchestration
    mempalace: false
    subagents: [annie, carren, vera]
---

## When to Use

- Assess one inline target or bounded set of target statements against explicit criteria.
- Use supplied evidence as caller-provided task material, with no independent verification claim.
- Return one categorical disposition, criterion-by-criterion outcomes, strengths, gaps, uncertainty, and bounded advice-only improvements.
- Preserve exact request, Annie analysis, Carren draft, Vera verification, and host-sealed product lineage.

## When Not to Use

- Gather, browse for, test, or externally verify evidence.
- Use numeric scoring, weighted totals, ranking theater, or invented precision.
- Execute improvements, start changes, write files, mutate systems, approve actions, or publish results.
- Assess a target or criterion set that is not supplied inline and closed at intake.

## Invocation Boundary

This is a model-visible, registered universal package. Pi native discovery and Penny's model-facing catalog may describe it, and explicit `skill` invocation is routed through the sole executable playbook registry with its bound contract. Model visibility does not bypass host-owned authorization or consequence boundaries.

## Invocation

```ts
skill({
  skill_name: "assess",
  goal: "Assess whether the supplied note satisfies the communication criteria.",
  constraints: {
    schema_version: 1,
    target: "Hello, team. The maintenance window is Tuesday at 09:00 UTC.",
    criteria: [
      { statement: "States the maintenance time clearly.", importance: "required" },
      { statement: "Uses a courteous tone.", importance: "advisory" },
    ],
    supplied_evidence: [
      { statement: "The note names Tuesday at 09:00 UTC.", source_label: "caller observation" },
    ],
    hard_constraints: [{ statement: "Do not externally verify the schedule." }],
    non_goals: [{ statement: "Do not rewrite or send the note." }],
    known_uncertainties: [{ statement: "The intended audience was not specified." }],
  },
});
```

`target` is either one nonempty inline string or one to 64 `{ statement }` items. Assess accepts no caller artifacts, including an empty artifact envelope.

## Orchestrated Flow

```text
intake (host canonical request)
  → analyzing_assessment (Annie; no final judgment)
  → authoring_assessment (Carren; complete subjective assessment draft)
  → sealing_assessment (host canonical AssessmentV2 with required-only effect graph)
  → verifying_assessment (Vera; objective contract/evidence/lineage verification)
  → admitting_assessment (host current-product validity receipt + integrity/envelope)
  → complete
```

Vera `analysis_gap` or `evidence_gap` returns through Annie and then Carren. `assessment_product_gap` returns directly to Carren. Every replacement draft is resealed and reverified. There is no separate Carren approval receipt because Carren authors the judgment.

## Exact Artifact Handoff

The host canonicalizes and persists `AssessmentRequestV1`. Ordinary workflow phases omit `allowed_tools`, so each phase uses its assigned catalog agent's exact YAML tool list. `artifact_read` remains mandatory for every needed exact workflow predecessor and workers continue through `next_range`; no other tool or channel may substitute for a missing predecessor ref. Memory, temporary files, repository search, historical sessions, and name-only pointers are never fallback handoff channels. Other YAML tools may be used only when materially relevant, permitted by the caller and task, and within the phase consequence boundary; they cannot enlarge the closed supplied-evidence boundary.

Normal-phase liveness permits at most eight external calls per worker and 64 per run; routing-only repair remains at zero. These are resource ceilings, not authority to browse, externally verify supplied evidence, execute, or mutate. The owner captures and re-reads exact bytes before routing, and memory availability cannot affect correctness.

## Output and Terminal Truth

The canonical semantic core is `penny.assessment.v2`. It has exactly one outcome for every criterion index; categorical verdicts and disposition; exact supplied-evidence indexes; summary; strengths; major/minor gaps; bounded advice-only improvements; assumptions; uncertainties; complete request coverage; exact source lineage; confidence; and a host-authored versioned effect-evidence graph. Each of external action, filesystem write, test execution, and task change separately records the absence policy, worker/run/phase scope, observation status/coverage/result/evidence refs, and prevention control/scope. Unsupported facts are `unknown`; host artifact persistence is explicitly outside worker-effect assurance.

`complete/met:true` means the latest exact assessment product passed Vera's objective checks and the host's deterministic current-product integrity/admission checks. It does not mean the target meets the criteria: all five valid dispositions may complete. An observed policy violation blocks completion. Unknown effects may complete only with the terminal's explicit unknown-effect limitation. Even bounded no-violation evidence is scoped evidence, not full filesystem or process confinement. Exhausted, stalled, malformed, stale, or missing-exact-input work terminates honestly as `incomplete`; cancellation is `cancelled`.

## Recovery and Consequence Boundary

Host sealing and admission are idempotent, exact-run, and recovery-safe. Recovery reuses selected refs and never searches memory. Active V1 effect checkpoints are refused rather than silently resealed as V2 evidence. The absence policy forbids external verification, numeric scoring, actions, worker writes, tests, changes, approval, executable registration, and model discovery; absent observation or prevention evidence remains unknown.
