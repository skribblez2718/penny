# Active Domain Skill Interfaces

Use the runtime registration and contract source as execution authority. The package references below explain the domain-specific semantics without duplicating executable schemas.

## Define

`define` creates or fully revises one canonical `SpecificationV1` before planning. It uses one cross-domain schema with immutable data-only profiles (`generic`, `software`, `business_process`, and `research`). The host derives an ordered `DefinitionSourceManifestV1` from the request; new starts use FrameV2 question IDs, per-question challenge/response, ordered EvidenceAdmissionV2 support slots, and a V2 draft footer with target-specific support claims. It seals the canonical product before projecting its exact `DefinitionTraceV1`, then binds both and current Vera/Carren reviews into admission. Exact hard constraints, non-goals, exclusions and binding decision effects are protected; unrepresentable new requests refuse before run/model creation rather than truncating caller intent. Caller-owned questions cannot be decided by Echo. Unresolved material questions keep readiness blocked, though a useful blocked specification may complete. Planning, taskification, and execution flags stay false.

Read `$PROJECT_ROOT/.pi/skills/define/README.md` and `$PROJECT_ROOT/.pi/skills/define/resources/reference.md` when changing or consuming this interface.

## Plan

`plan` actively emits `StrategyV2`. It optionally consumes one exact `SpecificationV1` in addition to GroundedSynthesisV1, DecisionV2, and EvidenceContextV1. Define-revise and Plan use a closed V2 invocation to select `reviewed_definition` (verified current owner completion/trace/reviews and immediate-parent closure) or `semantic_only` (canonical input bytes only); legacy V1 maps to semantic-only, absence of a specification to `not_applicable`. Strict refusal never falls back to semantic-only. The assurance artifact is consumer-bound, not a second semantic output or full-ancestry/external-source guarantee. A specification-informed strategy gives every required source item one disposition and maps every outcome back to source items or an explicit derived-need rationale. It cannot silently revise the specification, taskify, approve, mutate, or execute. Historical StrategyV1 validation remains explicit compatibility only.

Read `$PROJECT_ROOT/.pi/skills/plan/README.md` and `$PROJECT_ROOT/.pi/skills/plan/resources/reference.md` when changing or consuming this interface.

## Source-composition analysis

`sca` is one engine-backed security-analysis skill for PHP and JavaScript/TypeScript, not one of
the seven ordinary generic-child peers (`assess`, `decide`, `define`, `diagnose`, `plan`, `produce`,
`research`). Its registered cognitive phases use the real strict subset `["artifact_read"]`;
source/graph/evidence execution uses registered host operations, not agent shell or broker tools.
Apply the [binding runtime rule](../agents/discovery-and-tools.md#binding-runtime-rule). Use the existing skill registry, shared engine, catalog agents, exact immutable artifacts and registered host operations. The complete product scope includes deterministic scanners, source-bound graphs, focused alert/no-alert investigation, hypotheses, evidence decisions/gathering, dispositions, coverage reconciliation, validated learning, reporting and independent final verification. These are analytical data dependencies and capability tests, not independently certified/activated mini-products. Complete scanner-first integration and tests remain in progress until actual evidence establishes them.

Ordinary extension registration supplies exactly `sca_source_query`, `sca_graph_query` and `sca_application_test`; it imports no native operator/authentication ingress and registers no bootstrap, enrollment or login command. SCA-specific bootstrap, predecessor certification, activation, capsule/operator-profile and private permission prerequisites are retired. Retained dormant components/tests are not a setup path. Do not add a replacement install/auth UI or a new state/artifact owner.

Registered phase tool authority, exact input refs and declared limits remain required; application testing additionally needs exact execution-plan/policy artifacts and the trusted isolation boundary. Unavailable, failed, partial or truncated outcomes remain gaps. Source and graph preparation precede dependent cognition, reconciliation precedes learning/reporting, and evidence-aware report review plus independent verification precede normal platform human approval at actual release/publication. Ordinary non-SCA workflows receive no SCA tool authority.

Read `$PROJECT_ROOT/.pi/skills/sca/README.md` and `$PROJECT_ROOT/.pi/skills/sca/resources/reference.md` for the core-owned registered behavior and evidence model; runtime code remains authority, not historical setup instructions.
