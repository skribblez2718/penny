# Incident Response and Recovery

## Applies when

Changing security-sensitive services, credentials, sessions, privileged surfaces, public exposure, alerts, revocation, disablement, restore, or recovery procedures.

## Security properties

- Compromised authority can be contained, evidence preserved, service safely restored, and recurrence learned from.
- Response roles and recovery dependencies are known before an incident.

## Requirements

- Define how to disable exposure, revoke/rotate credentials and sessions, isolate workloads, preserve evidence, communicate, restore known-good artifacts/data, and validate recovery.
- Keep recovery operations least-privilege and auditable; ensure privileged access has a workable emergency path without weakening normal controls.
- Exercise material runbooks in controlled environments and update them when architecture changes.

## Failure modes

- Treating a postmortem or a log as a response plan.
- Deleting evidence, rotating only one dependent credential, or restoring without verifying integrity and exposure.
- Assuming a deployment rollback revokes compromised sessions, keys, or artifacts.

## Verification

- Tabletop and, where authorized, controlled exercises for disablement, credential/session revocation, restore, alert routing, and evidence preservation.
- Record unresolved recovery gaps explicitly.

## Related guidance

- [Secrets](secrets.md), [session security](session-security.md), and [supply chain](supply-chain.md) own key containment surfaces.
- [Logging and monitoring](logging-monitoring.md) supplies detection evidence.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
