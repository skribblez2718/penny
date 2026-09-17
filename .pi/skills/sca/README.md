# Source-Composition Analysis (`sca`)

`sca` is an engine-owned repository security-analysis workflow. `SKILL.md` is a thin invocation contract; the TypeScript registration and playbook own execution.

## Active flow

1. Host admission validates the absolute source root, immutable snapshot digest, normalized scope, execution mode, and three distinct pinned model identifiers.
2. The host creates a bounded read-only source census and heuristic static inventory with `model_invocation_count: 0`.
3. Two independent Annie branches analyze the same exact inventory using distinct caller-pinned models.
4. Vera reviews consensus and blocks unresolved evidence conflicts.
5. Skribble materializes the report from exact predecessors without filesystem writes.
6. Vera verifies the exact report.
7. The engine pauses for a human decision bound to the report artifact ID and digest. Only exact approval can complete the run.

The workflow never modifies the target. `propose_stronger_evidence` records evidence needs but does not authorize execution. The standalone SCA contracts and service provide stricter static normalization, proof gates, qualified evidence execution, and deterministic report/release primitives; integrating every external analyzer into the playbook remains visible through coverage limitations rather than being faked.

## Terminal meaning

Completion means the registered analysis and release gate completed for the admitted snapshot under disclosed coverage. It does not mean the repository is vulnerability-free.
