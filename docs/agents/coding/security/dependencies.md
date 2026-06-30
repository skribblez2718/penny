# Dependencies — Safe dependency management for generated code

## What

Never generate code that depends on known-vulnerable packages. Pin versions. Minimize the dependency tree.

## Why

Supply chain attacks and known CVEs in dependencies are the fastest-growing threat vector. Generated code that pulls in unvetted dependencies inherits their vulnerabilities.

## Rules

1. **Check for known CVEs before adding a dependency.** Use `cve_lookup_osv` for npm packages.
2. **Pin exact versions.** `"lodash": "4.17.21"`, not `"^4.0.0"`.
3. **Minimize dependencies.** Prefer standard library over third-party packages.
4. **Use lockfiles.** `package-lock.json` or `bun.lockb` committed to version control.
5. **Never depend on unmaintained packages.** Check last publish date. >1 year without updates = unmaintained.

## Constraints

- **CRITICAL severity.** Known-vulnerable dependencies must be fixed or replaced.
- **Version ranges (`^`, `~`) are prohibited** for generated dependency declarations.

## Verification

- [ ] No known CVEs in dependency tree
- [ ] Exact versions pinned
- [ ] Lockfile committed
- [ ] No unmaintained packages (>1 year)

## Files

| File | Purpose |
|------|---------|
| `docs/agents/coding/security/conventions.md` | Universal security rules |
