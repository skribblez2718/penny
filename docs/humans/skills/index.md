# Skills Documentation Index (Human-Facing)

- [overview.md](overview.md): Artifact-first engine workflows and the optional primary durable-memory boundary
- [design-methodology.md](design-methodology.md): How skills get designed — extracting phases from proven workflows, failure-mode-justified ordering, and where humans and knowledge fit
- [skill-standard.md](skill-standard.md): Exact artifact contracts, owner capture, memory-optional scaffolding, and required tests
- [orchestration.md](orchestration.md): How checkpoints, exact refs, continuation, owner capture, and recovery work
- [testing.md](testing.md): How skills are tested — unit, integration, and E2E standards
- [loops.md](loops.md): Agentic loops — what they are, the 7-class taxonomy (arrangements of the atomic components), which loops apply to which tasks, and how Penny implements them

## Active package references

- [Define](../../../.pi/skills/define/README.md): Cross-domain specification profiles, clarification, revision, and planning handoff
- [Plan](../../../.pi/skills/plan/README.md): StrategyV2, optional SpecificationV1 composition, traceability, and no-execution boundary
- [SCA](../../../.pi/skills/sca/README.md): Snapshot-bound security analysis, brokered inspection tools, evidence gates, and human release

## SCA: ordinary security analysis, not a separate installation

SCA covers PHP and JavaScript/TypeScript through the existing skill, engine, agents, exact artifacts and host-operation infrastructure. Its complete scope keeps scanners, program graphs, focused investigation, evidence gathering, coverage, learning, reporting and independent verification. These belong to one skill, not twelve separately approved products. Full scanner-first integration and tests remain in progress pending actual evidence.

There is no ordinary SCA bootstrap, enrollment/login, capsule/operator-profile or phase-activation prerequisite, and no replacement setup/auth UI. Dormant implementation components and historical tests/evidence remain for reference, not as required setup. The SCA extension registers only the existing source-query, graph-query and application-test broker tools.

Source/evidence checks, bounded isolated application execution and exact reporting still apply. Human approval uses the normal platform boundary at the actual verified-report release/publication consequence, not before ordinary engineering or testing. A completed analysis never certifies that a repository has no vulnerabilities.
