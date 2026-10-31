# Security Verification

## Applies when

A task changes a trust boundary or security-sensitive behavior and requires security-specific evidence.

## Security properties

- Verification demonstrates that affected invariants hold in the relevant implementation and deployment context.
- Evidence gaps are explicit rather than converted into ungrounded completion claims.

## Requirements

- Select adversarial tests, static/dynamic analysis, configuration inspection, dependency/supply-chain review, and operational checks from the changed threats and invariants.
- Test negative paths and boundary behavior; distinguish source review, test result, deployed inspection, and unverified assumption.
- Apply the [baseline completion and exception contract](security-invariants.md#requirements) to every affected invariant.
- Scope evidence to the [assigned stage and claim](../../agents/bounded-work.md#dependencies-and-composition):
  component tests do not qualify application integration, nor does integration alone qualify
  deployment. Missing later qualification blocks that claim, not independent earlier work;
  any control needed by earlier work still applies before the risk it governs begins.
- Challenge unsupported verification machinery and its cost under
  [proportionality](../../architecture/project-standards.md#proportionality-outcomes-before-mechanisms).
  Prior reviewer/model approval is neither independent evidence nor authority to waive a
  standard. Independent checks need not mean a new custom attestation mechanism.

## Failure modes

- Using a scanner, checklist, or unit-test count as proof of all security properties.
- Claiming an unrun production/deployment check passed.
- Treating an unapproved exception as a verification result.

## Verification

- Maintain an invariant-to-evidence map for the change and run the selected checks.
- Review failures, limitations, environment-dependent gaps, and residual risk before declaring completion.

## Related guidance

- [Security invariants](security-invariants.md) defines completion states.
- [Threat modeling](threat-model.md) identifies what to test; every topic guide provides subject-specific evidence.
