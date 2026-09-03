# File Handling

## Applies when

Accepting, creating, extracting, transforming, storing, serving, or deleting files, archives, paths, or temporary data.

## Security properties

- File operations cannot escape approved storage boundaries or cause unbounded parser, archive, or output work.
- Content handling and delivery do not turn untrusted files into executable or privileged content.

## Requirements

- Derive storage location server-side; normalize and authorize paths; use race-safe temporary creation and least-privilege permissions.
- Validate declared and detected content, size, count, archive paths, compression/expansion, recursion, metadata, and output before expensive processing.
- Define quarantine/scanning, retention, cleanup, serving disposition, and public/private storage boundaries according to risk.
- Do not extract archives until path, link, type, and expansion controls are in place.

## Failure modes

- Trusting extensions, client file names, archive members, or MIME declarations alone.
- Writing user paths directly, following archive symlinks, or using predictable temporary files.
- Serving untrusted active content as if it were a safe attachment.

## Verification

- Test traversal, absolute/encoded paths, symlinks, archive bombs, duplicate names, MIME mismatch, oversized output, cleanup, and authorization.
- Inspect storage permissions and response headers for download/preview behavior.

## Related guidance

- [Input validation](input-validation.md) owns boundary validation.
- [Resource limits](resource-limits.md) owns budgets; [configuration](configuration.md) and [secrets](secrets.md) cover storage isolation.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
