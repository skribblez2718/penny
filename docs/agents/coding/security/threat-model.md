# Threat Modeling

## Applies when

Adding or changing assets, identities, sensitive data, privileged actions, trust boundaries, external systems, or attacker-accessible capabilities.

## Security properties

- Assets, actors, entry points, trust boundaries, and abuse cases are explicit.
- Controls are selected for credible attacker actions and failure paths, not a generic checklist.

## Requirements

- State the assets and authority boundaries that change, including any public route, data flow, egress, file, compute, or privileged operation.
- Identify likely misuse, abuse, failure, and recovery paths; choose mitigations and evidence proportionate to impact.
- Distinguish required properties from proposed mechanisms under
  [proportionality](../../architecture/project-standards.md#proportionality-outcomes-before-mechanisms).
  Explain which credible threat/failure warrants a material added control and why a simpler
  alternative is insufficient; inherited model choices are not threat evidence.
- Refresh the model when scope or integration assumptions change.

## Failure modes

- Treating a feature name as a threat model.
- Copying a deployment or profile from another application into generic guidance.

## Verification

- Review the model with implementers or reviewers and link each material threat to a control and test/inspection.
- Verify that newly exposed capabilities were included in route, dependency, and operational inventories.

## Related guidance

- [Security invariants](security-invariants.md) define non-negotiable outcomes.
- [Security verification](security-verification.md) selects evidence.
