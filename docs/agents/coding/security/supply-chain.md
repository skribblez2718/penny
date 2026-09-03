# Supply-Chain Security

## Applies when

Changing registries, install/build scripts, CI credentials, artifacts, provenance, SBOMs, publication, or release workflows.

## Security properties

- Build inputs, credentials, execution, artifacts, and release publication have traceable authority and integrity.
- Compromise can be scoped through artifact identity and recovered through revocation and known-good rebuilds.

## Requirements

- Constrain registry sources, build scripts, CI identities, artifact permissions, and publication authority to the least capability needed.
- Preserve lockfile/integrity data, artifact identifiers, and provenance/SBOM evidence where proportionate to the release risk.
- Separate build and release credentials; protect them from logs and untrusted jobs; define revocation and rebuild paths.

## Failure modes

- Treating dependency scanning as complete supply-chain assurance.
- Letting untrusted build input access publication credentials or mutable release artifacts.
- Publishing without a traceable artifact identity or recovery plan.

## Verification

- Review CI/workflow permissions, registry configuration, build-script changes, artifact provenance/identity, and release authorization.
- Test credential revocation and known-good rebuild/release recovery where feasible.

## Related guidance

- [Dependencies](dependencies.md) owns package admission.
- [Secrets](secrets.md), [incident response](incident-response.md), and [security verification](security-verification.md) own related controls.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
