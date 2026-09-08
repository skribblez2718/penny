---
name: sca
description: "Run a durable, evidence-grounded secure code analysis campaign over an admitted immutable repository snapshot. Use when repository-scale vulnerability discovery needs host-owned scanners, bounded agent and universal-skill investigation, dynamic verification, coverage closure, and resumable terminal truth. Do not use for a quick code review, remediation, unauthorised target execution, or claims that an unverified repository is secure."
disable-model-invocation: true
metadata:
  penny:
    engine: orchestration
    mempalace: false
    subagents: [synthia, ida, demetri, annie, echo, piper, tabitha, vera, carren, skribble]
---

## When to Use

- After its future implementation and runtime registration, use `sca` for repository-scale secure code analysis where durable hypotheses, exact evidence, bounded iteration, coverage accounting, and recovery earn orchestration overhead.
- Use when external scanners or target execution must remain behind typed host-owned operator and isolation boundaries.
- Use when one user-visible invocation may contain several agent, universal-skill, static-analysis, and dynamic-verification passes.

## When Not to Use

- Do not use this design scaffold as an executable skill; the TypeScript playbook, child-skill dispatch primitive, closed contracts, and tests are not implemented yet.
- Do not use for a small supplied-code review that one focused agent can complete.
- Do not use to remediate or modify the audited target, run target code outside the admitted execution profile, or equate scanner silence with safety.
- Do not use when the source snapshot, scope, authority, evidence requirements, or completion rule are open.

## Invocation

Planned invocation after implementation and runtime registration:

```ts
skill({
  skill_name: "sca",
  goal: "Assess the admitted repository snapshot for security vulnerabilities.",
  constraints: {
    schema_version: 1,
    snapshot_ref: "<immutable-source-snapshot-ref>",
    scope: { include: ["..."], exclude: ["..."] },
    execution_profile: "static-safe",
    rulepack: {
      path: "<caller-supplied-external-rulepack>",
      release_digest: "sha256:<immutable-release-digest>",
      profile: "<named-profile>",
      candidate_workspace: "<run-scoped-workspace>",
      promotion_policy: "disabled | admitted",
    },
  },
});
```

`threat_model_mode` is optional and defaults to `adaptive`; the caller need not supply a threat model or threat-context hints. A caller that has useful context may optionally provide bounded hints or one exact supplied model ref. `formal_required` is explicit opt-in.

The current package is a design-stage, model-disabled development package. Generic skill ingress must reject it until its registered playbook and required runtime dependencies exist.

## Proposed Orchestrated Flow

The future engine-owned campaign admits one immutable request with optional caller threat context and an adaptive-or-formal modeling policy; admission never presumes a completed threat model. Host-owned baseline operators build the security evidence substrate and discover relevant repository documents as target-controlled evidence. Synthia then derives a versioned evidence-grounded security/threat model and refines it only for a material gap or explicit formal requirement. After that integration, an optional phase-two lane may materialize, validate, and scan bounded candidate Semgrep rules against the same frozen snapshot. The stronger phase-one lane mines rule variants after confirmed findings. Candidate matches enter the ordinary hypothesis and independent verification contract; they never confirm themselves. A verified true-positive generated rule may be persisted only by the separate host promotion operator under pre-admitted external-rulepack write authority, producing a successor immutable release for future campaigns without changing the current baseline.

The controller may dispatch focused catalog agents, the closed `research | decide | plan` universal child set, safe graph/static operators, or a gated dynamic-verification path. Every result returns by exact artifact reference to the hypothesis ledger. Coverage closure, Synthia assessment synthesis, Vera verification, Skribble/Carren reporting, and the host completion gate—not an actor's claim—decide terminal success.

See `resources/flow.html` and `README.md`. They are a proposed design target, not yet a mirror of a registered TypeScript descriptor.

## Exact Artifact Handoff

Every future cognitive directive and child-skill dispatch must carry owner-selected exact `input_artifacts` refs and an `output_artifact` contract. Workers and child runs read every needed exact ref with `artifact_read` through `next_range`, return complete stage content, and keep routing fields separate from product bytes. The SCA owner persists and re-reads exact bytes before routing. Memory, previews, mutable files, repository search, and name-only pointers are never workflow handoff.

Scanner output, source slices, versioned security/threat models, hypotheses, coverage, execution transcripts, reviews, and final products are immutable evidence artifacts with source-snapshot and tool provenance. Payload bytes do not enter checkpoint control state.

## Output and Terminal Truth

The planned positive result exposes one exact canonical security-assessment product plus security/threat-model, evidence, findings, hypothesis, coverage, generated-rule/promotion, report, SARIF, and tool-manifest refs. `complete/met:true` requires the admitted snapshot and scope, the latest exact security-model revision with material unknowns resolved or impact-disclosed, required analysis-family accounting, terminal dispositions for every admitted high-priority hypothesis, typed evidence for confirmed findings, disclosed unsupported/limited coverage, exact compatible `research | decide | plan` child lineage where used, Vera PASS on the current assessment and final product, Carren-approved report content, and host CompletionGate admission.

Budget exhaustion, stall, denied required execution, unavailable required backend, missing exact input, or an unresolved required evidence/coverage gap terminates honestly as `incomplete/met:false` with the best exact artifacts. Completion never means the repository is vulnerability-free.

## Recovery, Escalation, and Consequence Boundary

The future playbook must checkpoint the campaign ledger, selected refs, child-run links, aggregate budgets, pending host operations, and gate challenges under one SCA `run_id`. Recovery must reissue or adopt idempotent operations from exact refs. Material scope or authority expansion, unadmitted execution, network access, external-rulepack mutation without admitted write authority, or another reversibility cliff pauses through `await_user` or records an explicit skipped promotion according to the admitted policy; denial cannot become success.

Catalog workers do not receive scanner, compiler, fuzzer, container, or raw graph-interpreter authority. Host-owned operators run approved tools through typed, bounded interfaces. Dynamic target execution requires the admitted sandbox profile, read-only target input, isolated scratch output, no host credentials or Docker socket, network denied by default, command transcripts, and finite process/CPU/memory/time/output limits. A registration-bound tool subset does not itself provide OS or process isolation.
