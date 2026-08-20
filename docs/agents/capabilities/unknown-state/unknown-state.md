# Clarification escalation — TypeScript `await_user` seam

## What

When a worker cannot proceed honestly, a playbook emits an `await_user` directive and the
TypeScript engine checkpoints it. The same exact run resumes only through a matching
`respond` request. This is a control boundary, not a model-authored state blob.

## Triggers

- routing result sets `needs_clarification: true`;
- a required stage-complete field is false;
- confidence is `UNCERTAIN` where the playbook permits escalation;
- a bounded repair stalls or repeats the same unresolved gap;
- a planned gate reaches its review boundary.

## Resume

The pending directive carries `gate_id`, challenge, questions, state, and payload digest.
`respond` must match its run, gate, and challenge. The playbook stores the bounded answer
in `clarification_text`, selects the producer able to act, and emits that state’s next
exact directive. Recovery re-presents the same pending gate after restart.

Research resumes plan blockers at planning, evidence blockers at researching, and
synthesis/critique/validation blockers at synthesizing.

## Rules

1. Do not guess through a blocking ambiguity.
2. Do not convert a clarification pause into success or failure.
3. Do not accept an answer for another run/gate/challenge.
4. Keep predecessor refs checkpointed; never ask the user to resend payload text.
5. Planned approval and unplanned clarification may share `await_user`, but their
   decision vocabularies and authority remain distinct.

## Verification

- `apps/orchestration/tests/core-runtime.test.ts`
- `apps/orchestration/tests/kb-playbook.test.ts`
- `apps/orchestration/tests/research-parity.test.ts`
- `apps/orchestration/src/engine.ts`
- `apps/orchestration/src/playbooks/research.ts`
