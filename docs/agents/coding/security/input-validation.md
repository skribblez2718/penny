# Input Validation

## Applies when

User, network, file, environment, browser, integration, or persisted data crosses a trust boundary.

## Security properties

- External data has explicit syntax, structure, canonical representation, complexity, semantic, and business-rule constraints.
- Invalid or ambiguous data is rejected before it can alter authority, interpreter structure, or persistent state.

## Requirements

- Define accepted type, encoding/charset, size, character/byte count, collection count, nesting, numeric range/precision, format, unknown-field, and duplicate-parameter policy as applicable.
- Canonicalize before equality/authorization comparisons and distinguish syntactic validation from semantic and business validation.
- Choose a maintained validation mechanism appropriate to the stack; do not make a specific library universal.
- Bound regex/parser complexity and validate content type before expensive processing.

## Failure modes

- Assuming a parsed schema establishes business validity or authorization.
- Silently truncating, coercing, or accepting ambiguous duplicate values.
- Using an unbounded regex, parser, or nested structure at a boundary.

## Verification

- Test malformed, oversized, deeply nested, duplicate, unknown-field, encoding, canonicalization, semantic, and business-rule cases.
- Verify invalid input cannot reach a privileged sink or persistence path.

## Related guidance

- [Injection prevention](injection.md), [file handling](file-handling.md), and [API security](api-security.md) own specialized sinks and interfaces.
- [Resource limits](resource-limits.md) owns work budgets.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
