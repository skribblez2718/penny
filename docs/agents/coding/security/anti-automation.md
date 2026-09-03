# Anti-Automation and Abuse Resistance

## Applies when

An action is susceptible to brute force, enumeration, scraping, spam, replay, distributed abuse, or cost amplification.

## Security properties

- Sensitive and costly business flows resist repeated and distributed abuse without treating all automation as malicious.
- Controls retain useful account, source, and global visibility for escalation.

## Requirements

- Model abuse by operation and cost. Combine identity/account, source/device/session, route, concurrency, and global controls rather than relying on IP alone.
- Use generic responses, progressive delay, quotas, anomaly signals, challenges, and human review/escalation where proportionate.
- Make controls abuse-aware but accessible; do not assume CAPTCHA or a client fingerprint proves intent.

## Failure modes

- Blocking every automation request or treating IP rate limiting as sufficient.
- Protecting login but not recovery, signup, enumeration, export, scraping, replay, or expensive business flows.
- Making challenge success an authorization decision.

## Verification

- Simulate repeated, distributed, account-targeted, and cost-amplifying flows; verify false-positive handling and escalation.
- Measure control effectiveness and global saturation behavior.

## Related guidance

- [Resource limits](resource-limits.md) owns technical budgets.
- [Authentication](authentication.md), [API security](api-security.md), and [logging and monitoring](logging-monitoring.md) own adjacent controls.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
