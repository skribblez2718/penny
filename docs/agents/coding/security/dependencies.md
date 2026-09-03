# Dependencies

## Applies when

Adding, updating, pinning, removing, importing, or auditing packages and lockfiles.

## Security properties

- Dependencies have known identity, constrained version resolution, reviewed transitive change, maintenance evidence, and vulnerability status appropriate to risk.
- No-known-vulnerability is not confused with trust.

## Requirements

- Prefer existing or standard capabilities when they meet the requirement; otherwise verify exact package identity, publisher/repository, maintenance, license/policy fit, and install/build behavior.
- Review manifest and lockfile changes, transitive deltas, install scripts, integrity metadata, and current ecosystem advisories.
- Use the project’s package-manager and lockfile conventions; do not mandate one universal package manager or scanner.

## Failure modes

- Adding a package because an advisory scan is clean.
- Ignoring transitive changes, typosquatting, install scripts, abandoned maintenance, or lockfile drift.
- Claiming that exact pinning alone establishes provenance.

## Verification

- Record the dependency purpose and review manifest/lockfile diff, provenance/identity signals, maintenance, scripts, and advisory results.
- Run applicable ecosystem checks and state their coverage limits.

## Related guidance

- [Supply chain](supply-chain.md) owns registries, build, CI, artifacts, and release trust.
- [Library documentation](../library-docs.md) governs current upstream documentation lookup.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
