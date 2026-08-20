# Verification — evidence-grounded TypeScript gates

## What

Verification is a playbook state plus engine-enforced result contract. A verifier reports a
closed verdict and captured evidence; the run cannot advance on missing, malformed, or empty
required evidence. Exhaustion records an honest negative/unresolved result rather than a
fabricated pass.

## Rules

1. Result schemas are state-specific and closed.
2. Evidence-required fields must be non-empty.
3. `PASS`/`FAIL` vocabularies are contractual, not inferred from prose.
4. A failure routes to the producer that can repair it.
5. Repairs are bounded and re-enter verification.
6. Model diversity is supplementary; tests, tools, and sources remain the proof.
7. Human approval is separate from objective verification.

## Research example

The `validating` state requires `verdict`, `unsupported_claims`, and non-empty `evidence`;
`evidence_needed` may name researchable gaps. PASS advances to report writing. A researchable
gap returns to Echo, another grounding problem returns to Synthia, and exhaustion proceeds
with `grounded: false` plus unresolved claims.

## KB example

KB agents advise; deterministic lint and the host’s own capability/preimage/revision checks
establish whether publication or promotion preparation is valid. Human review does not replace
those checks, and child output never grants apply authority.

## Verification

- `apps/orchestration/src/contracts.ts`
- `apps/orchestration/src/engine.ts`
- `apps/orchestration/src/playbooks/research.ts`
- `apps/orchestration/src/playbooks/knowledge-base.ts`
- `apps/orchestration/tests/contracts.test.ts`
- `apps/orchestration/tests/research-parity.test.ts`
- `apps/orchestration/tests/kb-*.test.ts`
