# Security Verification

## Applies when

A task changes a trust boundary or security-sensitive behavior and requires security-specific evidence.

## Security properties

- Verification demonstrates that affected invariants hold in the relevant implementation and deployment context.
- Evidence gaps are explicit rather than converted into ungrounded completion claims.

## Requirements

- Select adversarial tests, static/dynamic analysis, configuration inspection, dependency/supply-chain review, and operational checks from the changed threats and invariants.
- Test negative paths and boundary behavior; distinguish source review, test result, deployed inspection, and unverified assumption.
- Record each affected invariant as satisfied with evidence, blocking, or covered by an approved exception with the required fields.

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

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
