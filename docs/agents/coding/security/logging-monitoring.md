# Security Logging and Monitoring

## Applies when

Emitting security-relevant logs, audit events, metrics, traces, alerts, or diagnostic data.

## Security properties

- Security-relevant behavior is observable, attributable where appropriate, and usable for detection without exposing secrets or unnecessary sensitive data.
- Signals support triage, containment, and post-incident reconstruction.

## Requirements

- Define event coverage for authentication, authorization denials, privileged actions, configuration changes, abuse controls, egress, sensitive data access, security failures, and recovery actions as applicable.
- Use structured event schemas, correlation identifiers, retention/access controls, integrity expectations, and actionable alert thresholds appropriate to the service.
- Minimize and redact secrets, tokens, credentials, and sensitive payloads; treat diagnostic telemetry as a data flow.

## Failure modes

- Logging secrets or full sensitive payloads in the name of observability.
- Recording only successful events, or collecting unactionable noise with no owner/response path.
- Treating an application log statement as monitoring coverage.

## Verification

- Test event emission, redaction, access controls, correlation, alert delivery, and failure handling.
- Perform a tabletop or controlled detection exercise for high-risk changes.

## Related guidance

- [Error handling](error-handling.md) owns safe exceptional behavior.
- [Incident response](incident-response.md) owns containment and recovery; [secrets](secrets.md) owns confidentiality.
